/*
 *
 * (c) Copyright Ascensio System Limited 2010-2016
 *
 * This program is freeware. You can redistribute it and/or modify it under the terms of the GNU 
 * General Public License (GPL) version 3 as published by the Free Software Foundation (https://www.gnu.org/copyleft/gpl.html). 
 * In accordance with Section 7(a) of the GNU GPL its Section 15 shall be amended to the effect that 
 * Ascensio System SIA expressly excludes the warranty of non-infringement of any third-party rights.
 *
 * THIS PROGRAM IS DISTRIBUTED WITHOUT ANY WARRANTY; WITHOUT EVEN THE IMPLIED WARRANTY OF MERCHANTABILITY OR
 * FITNESS FOR A PARTICULAR PURPOSE. For more details, see GNU GPL at https://www.gnu.org/copyleft/gpl.html
 *
 * You can contact Ascensio System SIA by email at sales@onlyoffice.com
 *
 * The interactive user interfaces in modified source and object code versions of ONLYOFFICE must display 
 * Appropriate Legal Notices, as required under Section 5 of the GNU GPL version 3.
 *
 * Pursuant to Section 7 ยง 3(b) of the GNU GPL you must retain the original ONLYOFFICE logo which contains 
 * relevant author attributions when distributing the software. If the display of the logo in its graphic 
 * form is not reasonably feasible for technical reasons, you must include the words "Powered by ONLYOFFICE" 
 * in every copy of the program you distribute. 
 * Pursuant to Section 7 ยง 3(e) we decline to grant you any rights under trademark law for use of our trademarks.
 *
*/
var config = require('config').get('services.CoAuthoring');
var co = require('co');
var cron = require('cron');
var taskResult = require('./taskresult');
var docsCoServer = require('./DocsCoServer');
var canvasService = require('./canvasservice');
var storage = require('./../../Common/sources/storage-base');
var utils = require('./../../Common/sources/utils');
var logger = require('./../../Common/sources/logger');
var constants = require('./../../Common/sources/constants');
var pubsubRedis = require('./pubsubRedis.js');
var queueService = require('./../../Common/sources/taskqueueRabbitMQ');

var cfgRedisPrefix = config.get('redis.prefix');
var cfgExpFilesCron = config.get('expire.filesCron');
var cfgExpDocumentsCron = config.get('expire.documentsCron');
var cfgExpFiles = config.get('expire.files');
var cfgExpFilesRemovedAtOnce = config.get('expire.filesremovedatonce');

var redisKeyDocuments = cfgRedisPrefix + constants.REDIS_KEY_DOCUMENTS;

var checkFileExpire = function() {
  return co(function* () {
    try {
      logger.debug('checkFileExpire start');
      var expired;
      var removedCount = 0;
      var currentRemovedCount;
      do {
        currentRemovedCount = 0;
        expired = yield taskResult.getExpired(cfgExpFilesRemovedAtOnce, cfgExpFiles);
        for (var i = 0; i < expired.length; ++i) {
          var docId = expired[i].id;
          //проверяем что никто не сидит в документе
          var hvals = yield docsCoServer.getAllPresencePromise(docId);
          if(0 == hvals.length){
            if (yield canvasService.cleanupCache(docId)) {
              currentRemovedCount++;
            }
          } else {
            logger.debug('checkFileExpire expire but presence: hvals = %s; docId = %s', hvals, docId);
          }
        }
        removedCount += currentRemovedCount;
      } while (currentRemovedCount > 0);
      logger.debug('checkFileExpire end: removedCount = %d', removedCount);
    } catch (e) {
      logger.error('checkFileExpire error:\r\n%s', e.stack);
    }
  });
};
var checkDocumentExpire = function() {
  return co(function* () {
    var queue = null;
    var removedCount = 0;
    var startSaveCount = 0;
    try {
      logger.debug('checkDocumentExpire start');
      var redisClient = pubsubRedis.getClientRedis();

      var now = (new Date()).getTime();
      var multi = redisClient.multi([
        ['zrangebyscore', redisKeyDocuments, 0, now],
        ['zremrangebyscore', redisKeyDocuments, 0, now]
      ]);
      var execRes = yield utils.promiseRedis(multi, multi.exec);
      var expiredKeys = execRes[0];
      if (expiredKeys.length > 0) {
        queue = new queueService();
        yield queue.initPromise(true, false, false, false);

        for (var i = 0; i < expiredKeys.length; ++i) {
          var docId = expiredKeys[i];
          if (docId) {
            var puckerIndex = yield docsCoServer.getChangesIndexPromise(docId);
            if (puckerIndex > 0) {
              yield docsCoServer.createSaveTimerPromise(docId, null, queue, true);
              startSaveCount++;
            } else {
              yield docsCoServer.cleanDocumentOnExitNoChangesPromise(docId);
              removedCount++;
            }
          }
        }
      }
    } catch (e) {
      logger.error('checkDocumentExpire error:\r\n%s', e.stack);
    } finally {
      try {
        if (queue) {
          yield queue.close();
        }
      } catch (e) {
        logger.error('checkDocumentExpire error:\r\n%s', e.stack);
      }
      logger.debug('checkDocumentExpire end: startSaveCount = %d, removedCount = %d', startSaveCount, removedCount);
    }
  });
};

var documentExpireJob = new cron.CronJob(cfgExpDocumentsCron, checkDocumentExpire);
documentExpireJob.start();

var fileExpireJob = new cron.CronJob(cfgExpFilesCron, checkFileExpire);
fileExpireJob.start();
