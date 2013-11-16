(function() {
  var Chat, ObjectID, STATUS_COMPLETE, STATUS_ERROR, STATUS_NOTCOMPLETE, STATUS_PENDING, async, dbQueue, insertCount, insertMessage, messageCount, parseChatResponse, request_done, request_max;

  async = require('async');

  ObjectID = Database.db.bson_serializer.ObjectID;

  STATUS_PENDING = 0;

  STATUS_ERROR = 1;

  STATUS_NOTCOMPLETE = 2;

  STATUS_COMPLETE = 3;

  request_max = 0;

  request_done = 0;

  messageCount = 0;

  insertCount = 0;

  Chat = GLOBAL.Chat = {
    tasks: {},
    length: 0,
    createTasks: function(timestampMin, callback) {
      var TSmax, TSmin, preparedTasks, timestampMax, _i, _ref;
      timestampMax = new Date().getTime();
      preparedTasks = [];
      for (TSmin = _i = timestampMin, _ref = Config.Chat.SplitTimespanMS; _ref > 0 ? _i <= timestampMax : _i >= timestampMax; TSmin = _i += _ref) {
        TSmax = Math.min(timestampMax, TSmin + Config.Chat.SplitTimespanMS - 1);
        if (TSmax === TSmin) {
          continue;
        }
        preparedTasks.push({
          data: {
            desiredNumItems: Config.Chat.FetchItemCount,
            minLatE6: Math.round(Config.Region.SouthWest.Lat * 1e6),
            minLngE6: Math.round(Config.Region.SouthWest.Lng * 1e6),
            maxLatE6: Math.round(Config.Region.NorthEast.Lat * 1e6),
            maxLngE6: Math.round(Config.Region.NorthEast.Lng * 1e6),
            minTimestampMs: TSmin,
            maxTimestampMs: TSmax,
            chatTab: 'all'
          },
          status: STATUS_PENDING,
          _id: new ObjectID()
        });
      }
      return async.eachLimit(preparedTasks, Config.Database.MaxParallel, function(task, callback) {
        Chat.tasks[task._id.toString()] = task;
        Chat.length++;
        return Database.db.collection('Chat._queue').insert(task, callback);
      }, function() {
        return Database.db.collection('Chat._data').update({
          _id: 'last_task'
        }, {
          $set: {
            timestamp: timestampMax
          }
        }, {
          upsert: true
        }, function(err) {
          logger.info("[Broadcasts] Created " + preparedTasks.length + " tasks (all " + Chat.length + " tasks).");
          return callback && callback.apply(this, arguments);
        });
      });
    },
    prepareFromDatabase: function(callback) {
      var timestampMin, timestampMinMax;
      logger.info("[Broadcasts] Continue: [" + Config.Region.SouthWest.Lat + "," + Config.Region.SouthWest.Lng + "]-[" + Config.Region.NorthEast.Lat + "," + Config.Region.NorthEast.Lng + "]");
      TaskManager.begin();
      timestampMin = new Date().getTime() - Config.Chat.TraceTimespanMS;
      timestampMinMax = new Date().getTime() - Config.Chat.MaxTraceTimespanMS;
      return async.series([
        function(callback) {
          return Database.db.collection('Chat._queue').find().toArray(function(err, tasks) {
            var task, _i, _len;
            if (tasks != null) {
              for (_i = 0, _len = tasks.length; _i < _len; _i++) {
                task = tasks[_i];
                Chat.tasks[task._id.toString()] = task;
                Chat.length++;
              }
            }
            return callback();
          });
        }, function(callback) {
          return Database.db.collection('Chat._data').findOne({
            _id: 'last_task'
          }, function(err, data) {
            if ((data != null ? data.timestamp : void 0) != null) {
              timestampMin = data.timestamp + 1;
            }
            if (timestampMin < timestampMinMax) {
              timestampMin = timestampMinMax;
            }
            return callback();
          });
        }, function(callback) {
          return Chat.createTasks(timestampMin, callback);
        }
      ], function() {
        callback();
        return TaskManager.end('Chat.prepareFromDatabase');
      });
    },
    prepareNew: function(callback) {
      var timestampMin;
      logger.info("[Broadcasts] New: [" + Config.Region.SouthWest.Lat + "," + Config.Region.SouthWest.Lng + "]-[" + Config.Region.NorthEast.Lat + "," + Config.Region.NorthEast.Lng + "]");
      timestampMin = new Date().getTime() - Config.Chat.TraceTimespanMS;
      return Chat.createTasks(timestampMin, callback);
    },
    start: function() {
      TaskManager.begin();
      return async.series([
        function(callback) {
          return Database.db.collection('Chat').ensureIndex({
            time: -1
          }, callback);
        }, function(callback) {
          return Database.db.collection('Chat').ensureIndex({
            'markup.player1.guid': 1
          }, callback);
        }, function(callback) {
          return Database.db.collection('Chat').ensureIndex({
            'markup.portal1.guid': 1
          }, callback);
        }
      ], function() {
        var taskId, taskList;
        taskList = [];
        for (taskId in Chat.tasks) {
          taskList.push(taskId);
        }
        if (taskList.length === 0) {
          logger.info("[Broadcasts] Nothing to request");
          TaskManager.end('Chat.start');
          return;
        }
        logger.info("[Broadcasts] Begin requesting...");
        return async.eachLimit(taskList, Config.Database.MaxParallel, function(taskId, callback) {
          return Chat.request(taskId, callback);
        }, function() {
          return TaskManager.end('Chat.start');
        });
      });
    },
    request: function(taskId, callback) {
      TaskManager.begin();
      Chat.tasks[taskId].status = STATUS_PENDING;
      return Database.db.collection('Chat._queue').update({
        _id: new ObjectID(taskId)
      }, {
        $set: {
          status: STATUS_PENDING
        }
      }, function(err) {
        callback && callback();
        request_max++;
        return Request.add({
          action: 'getPaginatedPlextsV2',
          data: Chat.tasks[taskId].data,
          onSuccess: function(response) {
            return parseChatResponse(taskId, response.result, noop);
          },
          onError: function(err) {
            return logger.error("[Broadcasts] " + err);
          },
          afterResponse: function() {
            request_done++;
            logger.info("[Broadcasts] " + Math.round(request_done / request_max * 100).toString() + ("%\t[" + request_done + "/" + request_max + "]") + ("\t" + messageCount + " messages (" + (dbQueue.length()) + " in buffer)"));
            return TaskManager.end('Chat.request.afterResponseCallback');
          }
        });
      });
    }
  };

  parseChatResponse = function(taskId, response, callback) {
    var maxTimestamp, rec, _i, _len;
    TaskManager.begin();
    for (_i = 0, _len = response.length; _i < _len; _i++) {
      rec = response[_i];
      insertMessage(rec[0], rec[1], rec[2]);
    }
    if (response.length < Config.Chat.FetchItemCount) {
      delete Chat.tasks[taskId];
      Chat.length--;
      return Database.db.collection('Chat._queue').remove({
        _id: new ObjectID(taskId)
      }, {
        single: true
      }, function() {
        callback();
        return TaskManager.end('parseChatResponse.case1.callback');
      });
    } else {
      maxTimestamp = parseInt(response[response.length - 1][1]) - 1;
      Chat.tasks[taskId].data.maxTimestampMs = maxTimestamp;
      Chat.tasks[taskId].status = STATUS_NOTCOMPLETE;
      return Database.db.collection('Chat._queue').update({
        _id: new ObjectID(taskId)
      }, {
        $set: {
          status: STATUS_NOTCOMPLETE,
          'data.maxTimestampMs': maxTimestamp
        }
      }, function() {
        Chat.request(taskId);
        callback();
        return TaskManager.end('parseChatResponse.case2.callback');
      });
    }
  };

  dbQueue = async.queue(function(task, callback) {
    return task(callback);
  }, Config.Database.MaxParallel);

  insertMessage = function(id, timestamp, data) {
    var count, data2, m, markup, _i, _len, _ref;
    TaskManager.begin();
    if (insertCount % 100 === 0) {
      Database.db.collection('Chat').count({}, function(err, count) {
        return messageCount = count;
      });
    }
    insertCount++;
    data2 = data.plext;
    markup = {};
    count = {};
    _ref = data.plext.markup;
    for (_i = 0, _len = _ref.length; _i < _len; _i++) {
      m = _ref[_i];
      if (count[m[0]] == null) {
        count[m[0]] = 0;
      }
      count[m[0]]++;
      markup[m[0] + count[m[0]].toString()] = m[1];
    }
    data2.markup = markup;
    return dbQueue.push(function(callback) {
      var doc;
      doc = data2;
      doc._id = id;
      doc.time = timestamp;
      return async.series([
        function(callback) {
          return Database.db.collection('Chat').insert(doc, callback);
        }, function(callback) {
          var level;
          if (doc.markup.PLAYER1 != null) {
            level = null;
            if (doc.markup.TEXT1.plain === ' deployed an ') {
              level = parseInt(doc.markup.TEXT2.plain.substr(1));
            }
            Agent.resolved(doc.markup.PLAYER1.guid, {
              name: doc.markup.PLAYER1.plain,
              team: Agent.strToTeam(doc.markup.PLAYER1.team),
              level: level
            });
          }
          return callback();
        }
      ], function() {
        callback();
        return TaskManager.end('dbQueue.queue.callback');
      });
    });
  };

}).call(this);
