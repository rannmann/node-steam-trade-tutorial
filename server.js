// In practice we would use a config.json file, but for this example we'll
// just do it inline.
username = 'your_username'; // Bot's Steam Username
password = 'your_password'; // Bot's Steam Password

// Define all our included variables
var steam      = require('steam');
var steamtrade = require('steam-trade');
var winston    = require('winston');

//These are included node modules that don't require installation via npm
var readline   = require('readline');
var fs = require('fs');

// We have to use application IDs in our requests, so this is just a helper
var appid = {
    TF2: 440,
    Steam: 753
};
// We also have to know context IDs which are a bit tricker.
// For Steam, ID 1 is gifts, and 6 is trading cards, emoticons, backgrounds
// For TF2 and DOTA we always use 2.  These are just some default values.
var contextid = {
    TF2: 2,
    Steam: 6
}

// We'll reference this to make sure we're only in one trade at a time.
var inTrade = false;

// Since we're taking user input inside the trade window, we have to make our
// inventory global.  Otherwise our trade chat listener doesn't know what we have.
var myBackpack;

// Setup readline to read from console.  This is used for Steam Guard codes.
var rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Setup logging to file and console
var logger = new (winston.Logger)({
        transports: [
            new (winston.transports.Console)({
                colorize: true, 
                level: 'debug'
            }),
            new (winston.transports.File)({
                level: 'info', 
                timestamp: true, 
                filename: 'cratedump.log', 
                json: false
            })
        ]
});

// Initialize the Steam client and our trading library
var client = new steam.SteamClient();
var trade  = new steamtrade();

// Our library has a list of Steam servers in case one isn't provided.
// You can define them if you want to make sure they're accurate;
// Just make sure to keep them up to date or you could run into issues.
if(fs.existsSync('servers.json')) {
    steam.servers = JSON.parse(fs.readFileSync('servers.json'));
}

// We can provide a sentry file for Steam Guard when we login to avoid
// having to enter a code each time.  If we have one saved to file, use it.
var sentryfile;
if(fs.existsSync('sentryfile.' + username + '.hash')) {
    sentryfile = fs.readFileSync('sentryfile.' + username + '.hash');
}

// Now we can finally start doing stuff!  Let's try logging in.
client.logOn({
    accountName: username, 
    password: password, 
    shaSentryfile: sentryfile // If null, a new Steam Guard code will be requested
});

// If Steam returns an error the "error" event is emitted.
// We can deal with some of them.
// See docs on Event Emitter to understand how this works: 
// http://nodejs.org/api/events.html
client.on('error', function(e) {
    // Error code for invalid Steam Guard code
    if (e.eresult == steam.EResult.AccountLogonDenied) {
        // Prompt the user for Steam Gaurd code
        rl.question('Steam Guard Code: ', function(code) {
            // Try logging on again
            client.logOn({
                accountName: username,
                password: password,
                authCode: code
            });
        });
    } else { // For simplicity, we'll just log anything else.
        // A list of ENUMs can be found here: 
        // https://github.com/SteamRE/SteamKit/blob/d0114b0cc8779dff915c4d62e0952cbe32202289/Resources/SteamLanguage/eresult.steamd
        logger.error('Steam Error: ' + e.eresult);
        // Note: Sometimes Steam returns InvalidPassword (5) for valid passwords.
        // Simply trying again solves the problem a lot of the time.
    }
});

// If we just entered a Steam Guard code, the "sentry" event goes off
// with our new hash.
client.on('sentry', function(sentry) {
    logger.info('Got new sentry file hash from Steam.  Saving.');
    fs.writeFile('sentryfile.' + username + '.hash', sentry);
});

// After successful login...
client.on('loggedOn', function() {
    logger.info('Logged on to Steam');
    // Optional: Rename the bot on login.
    client.setPersonaName("CrateDumpBot"); 
    // Make sure we're not displaying as online until we're ready
    client.setPersonaState(steam.EPersonaState.Offline); 
});

/* At this point, you should be logged into Steam but appear offline.
 * We haven't logged into the web API yet to do any trading.
 * Steam hands us a session ID before we can use the API.
 * Additionally, our Trade library requires the session ID and cookie,
 * so we have to wait for the following event to be emitted.
*/
client.on('webSessionID', function(sessionid) {
    trade.sessionID = sessionid; // Share the session between libraries
    client.webLogOn(function(cookie) {
        cookie.forEach(function(part) { // Share the cookie between libraries
            trade.setCookie(part.trim()); // Now we can trade!
        });
        logger.info('Logged into web');
        // No longer appear offline
        client.setPersonaState(steam.EPersonaState.LookingToTrade); 
    });
});

/* This is the end of the required core functionality, but we can build
 * a skeleton for some of the commonly-used listeners.
 */

// If a user adds me...
client.on('friend', function(steamID, relationship) {
    if (relationship == steam.EFriendRelationship.PendingInvitee) {
        logger.info('[' + steamID + '] Accepted friend request');
        client.addFriend(steamID);
    }
    else if (relationship == steam.EFriendRelationship.None) {
        logger.info('[' + steamID + '] Un-friended');
    }
});

// If a user messages me through Steam...
client.on('friendMsg', function(steamID, message, type) {
    if (type == steam.EChatEntryType.ChatMsg) { // Regular chat message
        logger.info('[' + steamID + '] MSG: ' + message); // Log it
        client.sendMessage(steamID, 'I\'m a bot that accepts all your unwanted items.  If you would like to grab a few crates from me, please request a trade.');
    }
});

// If a user sends a trade request...
client.on('tradeProposed', function(tradeID, steamID) {
    if (inTrade) {
        client.respondToTrade(tradeID, false); // Decline
        client.sendMessage(steamID, 'I\'m currently trading with someone else.');
    } else {
        client.respondToTrade(tradeID, true); // Accept
        logger.info('[' + steamID + '] Accepted trade request');
    }
});

// After we accept the trade, we deal with the trade session
client.on('sessionStart', function(steamID) {
    inTrade = true;
    client.setPersonaState(steam.EPersonaState.Busy);
    trade.open(steamID, function() { // Pass the trade off to our steam-trade library
        trade.loadInventory(appid.TF2, contextid.TF2, function(inv) {
            if (!inv) {
                logger.error('Error getting own inventory.  Cancelling trade.');
                client.sendMessage(steamID, 'Could not load my inventory.  Please try again later.');
                trade.cancel(steamID);
            } else {
                logger.debug('Found '+inv.length+' items in my inventory.');
                myBackpack = inv; // Now we can access it globally
                // If you want to put items up in the trade window immediately,
                // here is where you could do it. Instead we're calling a custom function.
                onTradeStart(steamID); // Our custom function
            }
        });
    });
});

// Messages received in the trade window
trade.on('chatMsg', function(msg) {
    logger.debug('TradeMsg: '+msg);
    // Use regex grouping to parse the result as we check syntax
    if (req = msg.match(/^!add (\d+) (\d+)/i)) {
        var series = req[1];
        var amount = req[2];
        addCrates(series, amount); // Our custom function
    } else {
        trade.chatMsg('Unrecognized command.  Please use !add <series> <amount>');
    }
});

// When they ready up
trade.on('ready',function() {
    logger.debug('User clicked ready');
    trade.ready(function() {
        // In theory you should be able to confirm the trade now,
        // but in practice Steam is sometimes too slow.  A 1.5
        // sec delay is added to compensate.
        setTimeout(function () {
            trade.confirm(function() {
                logger.debug('Confirming Trade');
            });
        }, 1500);
    });
});

// Any time an item changes in the trade window
trade.on('offerChanged', function(itemAdded, item) {
    if (itemAdded)
        logger.info('User added: '+item.name);
    else
        logger.info('User removed: '+item.name);
});

// If they uncheck ready
trade.on('unready',function() {
    // Once again, we don't care in this case.
    logger.debug('User clicked unready');
});

// Trade ends (successfully or otherwise)
trade.on('end', function(result, getItems) {
    inTrade = false; // Allow new trades
    myBackpack = null; // Prevent stale backpack information by resetting
    // Change from Busy back to Looking To Trade
    client.setPersonaState(steam.EPersonaState.LookingToTrade);

    if (result == 'timeout') {
        logger.warn('Trade timed out');
        client.sendMessage(trade.tradePartnerSteamID, 'The trade timed out. This usually means Steam is having problems. Please try again later.');
    } else if (result == 'complete') {
        logger.info('Trade complete');
    } else { 
        logger.debug('Trade ended: '+result);
    }
});

function onTradeStart(steamID) {
    trade.chatMsg('If you\'re adding crates, please put them up now.', function() {
        trade.chatMsg('Any other items traded to me will be considered a donation.', function() {
            trade.chatMsg('If you want a crate, request one via the following command: ', function() {
                trade.chatMsg('!add <series> <amount>', function() {
                    trade.chatMsg('ex: "!add 82 5" will add 5 crates of series #82');
                });
            });
        });
    });
}

function addCrates(series, amount) {
    // Filter out all the crates
    var pool = myBackpack.filter(function (item) {
        return item.tags.some(function(element, index, array) {
            return element.internal_name == 'Supply Crate';
        });
    });

    // Filter out the series
    var re = new RegExp('#' + series, 'i'); // ex: #82
    pool = pool.filter(function (item) {
        return item.name.match(re);
    });

    // Let the user know we don't have enough
    if (amount > pool.length) {
        logger.debug('User requested '+amount+' of series '+series+'.  I only have '+pool.length+' available.');
        trade.chatMsg('I have '+pool.length+' crates of series '+series+' available.');
    }

    // Add what we should to the current trade
    for (var i = 0; i < amount && i < pool.length; i++) {
        logger.debug('Adding '+pool[i].name);
        trade.addItem(pool[i]);
    }
}
