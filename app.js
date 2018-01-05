const ccxt = require('ccxt');
const _ = require('lodash');
const async = require('async');
const log4js = require('log4js');
const mongoose = require('mongoose');
const Promise = require('bluebird');
const Crypto = require('./models/crypto');
const config = require('./config');
var firstRun = false;

log4js.configure({
    appenders: { logFile: { type: 'file', filename: 'log.txt' } },
    categories: { default: { appenders: ['logFile'], level: 'info' } }
});
const logger = log4js.getLogger('logFile');

function main() {
    logger.info('Starting crypto alerts');
    connectDb().then(function() {
        Crypto.count({}).exec((err, coins) => {
            if(err) handleReject(err);

            if(!coins) {
                firstRun = true;
                logger.info('Initiating first run. Alarms will not fire!');
            }

            processExchanges();
        });
    }).catch(handleReject);
}

function connectDb() {
    return new Promise(function(resolve, reject) {
        var url = 'mongodb://localhost/cryptoTrader';

        var options = {
            useMongoClient: true,
            autoIndex: false, // Don't build indexes
            reconnectTries: Number.MAX_VALUE, // Never stop trying to reconnect
            reconnectInterval: 500, // Reconnect every 500ms
            poolSize: 10, // Maintain up to 10 socket connections
            // If not connected, return errors immediately rather than waiting for reconnect
            bufferMaxEntries: 0
        };

        mongoose.connection.once('open', function() {
            logger.info('MongoDB event open');
            logger.debug('MongoDB connected [%s]', url);

            mongoose.connection.on('connected', function() {
                logger.info('MongoDB event connected');
            });

            mongoose.connection.on('disconnected', function() {
                logger.warn('MongoDB event disconnected');
            });

            mongoose.connection.on('reconnected', function() {
                logger.info('MongoDB event reconnected');
            });

            mongoose.connection.on('error', function(err) {
                logger.error('MongoDB event error: ' + err);
            });

            return resolve();
        });

        mongoose.connect(url, options, function(err) {
            if (err) {
                handleReject(err);
            }
        });
    });
}

function processExchanges() {
    var exchanges = _.filter(config.exchanges, (exchange) => { return exchange.enabled; });

    Promise.each(exchanges, (exchange) => {
        processExchange(exchange);
    }).then(() => {
        if(firstRun) firstRun = false;

        logger.info('Finished!');
        logger.info('Waiting 1 minute to run again...');
        setTimeout(function(){
            processExchanges();
        }, 60000);
    }).catch(handleReject)
}

function processExchange(exchange) {
    return new Promise((resolve, reject) => {
        logger.info('Processing exchange ' + exchange.exchange);
        fetchMarketsForExchange(exchange.exchange).then((markets) => {
            return new Promise.each(markets, (market) => {
                return processMarket(market, exchange);
            });
        }).then((markets) => {
            saveMarketsToDb(markets).then(resolve).catch(reject)
        }).catch(reject)
    })
}

function processMarket(market, exchange) {
    return new Promise((resolve, reject) => {
        _.extend(market, { exchange: exchange.exchange } );
        Crypto.findOne({id: market.id, exchange: market.exchange, isTrading: true}).exec((err, result) => {
            if(err) return reject(err);

            if(!_.isEmpty(result)) resolve();

            checkIfTrading(market).then((isTrading) => {
                if(isTrading) _.extend(market, { isTrading: true });

                resolve(market);
            }).catch(reject);
        });
    })
}

//todo - finish this method. check for active trades
function checkIfTrading(market) {
    return new Promise((resolve, reject) => {
        resolve(true);
    })
}

function saveMarketsToDb(markets) {
    return new Promise.each(markets, (market) => {
        return saveMarket(market);
    });
}

function saveMarket(market) {
    return new Promise((resolve, reject) => {
        Crypto.findOne({id: market.id, exchange: market.exchange}).exec((err, result) => {
            if(err) return reject(err);

            upsertCrypto(market).then(() => {
                if(!result && !firstRun) {
                    notifySubscribers(market, ' is listed').then(resolve).catch(reject);
                } else if( _.has(result, 'isTrading') && !result.isTrading && market.isTrading) {
                    notifySubscribers(market, ' is trading').then(resolve).catch(reject);
                } else {
                    resolve();
                }
            }).catch(reject);
        });
    })
}

function upsertCrypto(update) {
    return new Promise((resolve, reject) => {
        Crypto.findOneAndUpdate({ id: update.id, exchange: update.exchange }, update, { upsert: true, new: true, setDefaultsOnInsert: true }, (err) => {
            if(err) return handleReject(err);
            logger.debug('Upserted ' + update.id + ' [' + update.exchange + '] to db');
            resolve(update);
        });
    });
}

function notifySubscribers(market, msg) {
    return Promise.all([
        notifyEmailSubscribers(market, msg),
        notifySmsSubscribers(market, msg),
        notifyVoiceSubscribers(market, msg)
    ])
}

function notifyEmailSubscribers() {
    return new Promise(function(resolve, reject) {
        if(_.get(config, 'notify.email.enabled', false) === false) return resolve();
        resolve();
    });
}

function notifySmsSubscribers(market, msg) {
    return new Promise(function(resolve, reject) {
        if(_.get(config, 'notify.sms.enabled', false) === false) return resolve();

        var client = require('twilio')(_.get(config, 'notify.sms.twilioAccountSid'), _.get(config, 'notify.sms.twilioAuthToken'));
        async.eachLimit(_.get(config, 'notify.sms.subscribers', []), 10, (subscriber, cb) => {
            client.messages.create({
                to: subscriber,
                from: _.get(config, 'notify.sms.from', ''),
                body: market.base + msg + " on " + market.exchange
            }, (err) => {
                if(err) return cb(err);
                return cb();
            });
        }, (err) => {
            if(err) return handleReject(err);
            resolve();
        });
    });
}

function notifyVoiceSubscribers(market, msg) {
    return new Promise(function (resolve, reject) {
        if(_.get(config, 'notify.voice.enabled', false) === false) return resolve();

        var client = require('twilio')(_.get(config, 'notify.voice.twilioAccountSid'), _.get(config, 'notify.voice.twilioAuthToken'));
        async.eachLimit(_.get(config, 'notify.voice.subscribers', []), 10, (subscriber, cb) => {
            client.calls.create({
                to: subscriber,
                from: _.get(config, 'notify.voice.from', ''),
                body: market.id + msg + " on " + market.exchange,
                url: _.get(config, 'notify.voice.url', 'http://demo.twilio.com/docs/voice.xml'),
            }, (err) => {
                if (err) return cb(err);
                return cb();
            });
        }, (err) => {
            if (err) return handleReject(err);
            resolve();
        });
    });
}

function handleReject(err) {
    return new Promise(function(resolve, reject) {
        logger.error('Handling reject', JSON.stringify(err));
        reject(err);
    });
}

function fetchMarketsForExchange(exchangeName) {
    return new Promise((resolve, reject) => {
        var exchange = new ccxt[exchangeName](config.exchanges[exchangeName]);
        exchange.loadMarkets().then((markets) => {
            resolve(_.map(markets, (market) => { return _.extend(market, { exchange: exchangeName }) }));
        }).catch(reject);
    });
}

if (module === require.main) {
    main();
}

module.exports = exports;