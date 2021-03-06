'use strict';

/**
 * Buffer is a class holding the raw events received from all application servers
 * Buffer should enable a processing pipeline which is responsible for restructure the raw events in a format of tree
 * Buffer should also be an EventEmitter, which fires higher level events like 'transaction completed', 'event completed' etc. to allow downstream
 * listeners (CAL publisher) to react to those events.
 *
 * For the restructure task, here're 2 major types of logs:
 * 1. single event
 *  heartbeat or error are of such kind, we could identify them by the schema below where an event has no parent, no begin or end marker either
 * 2. transaction
 *  transaction is the most common type, user request is mapped to a transaction, according to the schema below, transaction is an event with no parent
 *  begins with a marker of 'begin', and ends with a marker of 'end', it_this has an event id, which all of the events enclosed by this transaction is
 *  labeled with.
 *
 * Schema:
 *
 * Log -> SingleEvent | Transaction;
 * SingleEvent -> Event[parent=null&&begin=null&end=null]
 * Transaction -> Event[parent=null&&begin=true&&eventId=E]
 *  Log[parent=E]*
 *  Event[parent=null&&end=true]
 */
var _ = require('underscore'),
    crypto = require('crypto'),
    util = require('util');

var VALID_CLAZZ = ['atomicEvent', 'heartbeat', 'begin', 'end'],
    //standardized the tid pseudo assignment
    //pid must be used as a prefix, and the uuid will be hashed, and only the last char of hex encoded will be used, giving an equal oppotunity of 1/16
    assignThread = function assignThread(pid, uuid){
        var md5 = crypto.createHash('md5');
        md5.update(uuid || '');
        var hex = md5.digest('hex');
        //using the last char of a md5 hex encoding, giving it a fair chance of being one of the 16 chars.
        return pid + '-' + hex[hex.length-1];
    },
    DEFAULT_MAPPER = function DEFAULT_MAPPER(log){

        var mapped = {
            'type'  :     log.type || 'URL',
            'name':       log.name,
            'request':    log.uuid,
            'parent':     log.parent || '0',
            'clazz':      log.clazz || 'atomicEvent',
            'event' :     log.event,
            'duration':   log.duration,
            'pid':        log.pid,
            'tid':        log.tid || assignThread(log.pid, log.uuid),
            'machine':    log.machine,
            'ipAddress':  log.ipAddress || log.ip,
            'pool':       log.pool,
            'level':      log.level,
            'msg':        log.msg,
            'rlogid':     log.rlogid,
            'timestamp':  log.timestamp || Date.now()
        };
        //in case there's anything else not mapped.
        _.defaults(mapped, log);

        return mapped;
    },
    makeTree = function makeTree(family, node){

        if(!node){
            return null;
        }
        else if('atomicEvent' === node.clazz){
            return node;
        }
        else if('heartbeat' === node.clazz){
            return node;
        }
        else if('end' === node.clazz){
            return node;
        }

        var children = family[node.event] || [];

        node.children = _.values(_.reduce(children, function(memoize, c){
            var child = makeTree(family, c),
                begin = memoize[c.event];
            if(!begin){//begin of nested transaction
                memoize[c.event] = child;
            }
            else{//end of nested transaction, we'll need to update msg & duration;
                _.extend(begin, {
                    'type': c.type,
                    'name': c.name,
                    'msg': c.msg,
                    'duration': c.duration,
                    'status': c.status
                });//https://jirap.corp.ebay.com/browse/POLYGLOT-337
            }
            return memoize;
        }, {}));

        return node;
    },
    validateTree = function validateTree(family, node){

        if(!node){
            return 'end';
        }
        else if('atomicEvent' === node.clazz || 'heartbeat' === node.clazz){
            return 'end';
        }

        var complete = _.reduce(family[node.event] || [], function(memoize, c){
            if(!memoize || !validateTree(family, c)){
                return null;
            }

            if(c.clazz === 'begin'){
                memoize[c.event] = 'begin';
            }
            else{
                memoize[c.event] = 'end';
            }
            return memoize;
        }, {});

        if(!complete){
            return false;
        }

        var children = _.values(complete);
        return _.isEmpty(children) || _.every(children, function(elem){
            return elem === 'end';
        });
    };

var LogBuffer = exports.LogBuffer = function(emitter, mapper){

    var _this = this;
    _.extend(this, {
        'transactions': {},
        'atomicEvents': [],
        'heartbeats': [],
        'mapper': mapper || DEFAULT_MAPPER
    });

    emitter.on('log', function(log){

        var mapped = _this.mapper(log),
            parent = mapped.parent,
            clazz = mapped.clazz,
            begin  = 'begin' === clazz,
            end    = 'end' === clazz,
            event  = mapped.event,
            request= mapped.request;

        //console.log(util.format('[mapped] %j, [begin] %s, [end] %s', mapped, begin, end));
        if(!_.contains(VALID_CLAZZ, clazz)){//must be one of the valid event types
            console.log(util.format('clazz:%s of log:%j cannot be processed, as the clazz is invalid, should be one of %j', clazz, log, VALID_CLAZZ));
        }

        if(parent === '0' && !begin && !end){
            if('atomicEvent' === clazz){
                _this.atomicEvents.push(mapped);

                emitter.emit('atomicEvent', mapped);
            }
            else if('heartbeat' === clazz){
                _this.heartbeats.push(mapped);

                emitter.emit('heartbeat', mapped);
            }
        }
        else if(parent === '0' && begin){
            //create the root transaction with empty family tree
            var root = _this.transactions[request] = mapped;
            root.family = {};
        }
        else if(parent === '0' && end){
            var transaction = _this.transactions[request];
            if(!transaction){
                mapped.family = {};//tolerate case where 'begin' event is missing;
                _this.transactions[request] = mapped;
            }

            //bugfix for missing name, status updates of root transaction
            _.extend(transaction, {
                'name': mapped.name,
                'msg': mapped.msg,
                'duration': mapped.duration || Date.now() - transaction.timestamp,
                'status': mapped.status || '-1'
            });//indicate it's incomplete

            if(validateTree(transaction.family, transaction)){
                emitter.emit('transaction', makeTree(transaction.family, transaction));
            }
            else{
                transaction.age = 1;
            }
        }
        else{
            //tolerate case where 'begin' event is missing;
            var transaction = _this.transactions[request];
            if(!transaction){
                _this.transactions[request] = {'family':{}};
            }
            //parent & event would form a family map naturally
            //but must be scoped by request (otherwise, parent or event id could duplicate with others)
            //so the top scope request keeps both the family map & children list
            //the family map would be used to traverse the whole tree and get removed after the request has been published to CAL
            //to restore the tree structure, simply start with root, get all children, map each child to their children in depth first order using family map
            var family = _this.transactions[request].family;
            family[parent] = family[parent] || [];
            family[parent].push(mapped);
        }
    });

    emitter.on('clean', function(till){
        //console.log('[clean] transactions:%j vs. till:%d', _this.transactions, till);
        _.each(_this.atomicEvents, function(a, i){
            if(a.timestamp <= till){
                _this.atomicEvents[i] = null;
            }
        });
        _this.atomicEvents = _.compact(_this.atomicEvents);

        _.each(_this.heartbeats, function(h, i){
            if(h.timestamp <= till){
                _this.heartbeats[i] = null;
            }
        });
        _this.heartbeats = _.compact(_this.heartbeats);

        _.each(_this.transactions, function(tx, req){
            //console.log(util.format('[clean] %j vs. till:%d', tx, till));
            if(tx.timestamp <= till){
                var transaction = _this.transactions[req];
                if(transaction.age){
                    transaction.age = validateTree(transaction.family, transaction) ? 3 : transaction.age + 1;

                    if(transaction.age >= 3){//forced to emit incomplete tree
                        emitter.emit('transaction', makeTree(transaction.family, transaction));
                        transaction.age = null;//clean next cycle
                    }
                }
                else{
                    delete _this.transactions[req];
                }
            }
        });

        emitter.emit('cleaned', {
            'till': till, 
            'atomicEvents' : _this.atomicEvents.length,
            'heartbeats' : _this.heartbeats.length,
            'transactions': _.keys(_this.transactions).length
        });
    });
};
