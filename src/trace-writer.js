/**
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

var gcpMetadata = require('gcp-metadata');
var common = require('@google-cloud/common');
var util = require('util');
var traceLabels = require('./trace-labels.js');
var pjson = require('../package.json');
var constants = require('./constants.js');

/* @const {Array<string>} list of scopes needed to operate with the trace API */
var SCOPES = ['https://www.googleapis.com/auth/trace.append'];

var headers = {};
headers[constants.TRACE_AGENT_REQUEST_HEADER] = 1;

/**
 * Creates a basic trace writer.
 * @param {!Logger} logger The Trace Agent's logger object.
 * @param {Object} config A config object containing information about
 *   authorization credentials.
 * @constructor
 */
function TraceWriter(logger, options) {
  options = options || {};

  var serviceOptions = {
    packageJson: pjson,
    projectIdRequired: false,
    baseUrl: 'https://cloudtrace.googleapis.com/v1',
    scopes: SCOPES
  };
  common.Service.call(this, serviceOptions, options);

  /** @private */
  this.logger_ = logger;

  /** @private */
  this.config_ = options;

  /** @private {Array<string>} stringified traces to be published */
  this.buffer_ = [];

  /** @private {Object} default labels to be attached to written spans */
  this.defaultLabels_ = {};

  /** @private {Boolean} whether the trace writer is active */
  this.isActive = true;

  // Schedule periodic flushing of the buffer, but only if we are able to get
  // the project number (potentially from the network.)
  var that = this;
  that.getProjectId(function(err, project) {
    if (err) { return; } // ignore as index.js takes care of this.
    that.scheduleFlush_(project);
  });

  that.getHostname(function(hostname) {
    that.getInstanceId(function(instanceId) {
      var labels = {};
      labels[traceLabels.AGENT_DATA] = 'node ' + pjson.name + ' v' + pjson.version;
      labels[traceLabels.GCE_HOSTNAME] = hostname;
      if (instanceId) {
        labels[traceLabels.GCE_INSTANCE_ID] = instanceId;
      }
      var moduleName = that.config_.serviceContext.service || hostname;
      labels[traceLabels.GAE_MODULE_NAME] = moduleName;

      var moduleVersion = that.config_.serviceContext.version;
      if (moduleVersion) {
        labels[traceLabels.GAE_MODULE_VERSION] = moduleVersion;
        var minorVersion = that.config_.serviceContext.minorVersion;
        if (minorVersion) {
          var versionLabel = '';
          if (moduleName !== 'default') {
            versionLabel = moduleName + ':';
          }
          versionLabel += moduleVersion + '.' + minorVersion;
          labels[traceLabels.GAE_VERSION] = versionLabel;
        }
      }
      Object.freeze(labels);
      that.defaultLabels_ = labels;
    });
  });
}
util.inherits(TraceWriter, common.Service);

TraceWriter.prototype.stop = function() {
  this.isActive = false;
};

TraceWriter.prototype.getHostname = function(cb) {
  var that = this;
  gcpMetadata.instance({
    property: 'hostname',
    headers: headers
  }, function(err, response, hostname) {
    if (err && err.code !== 'ENOTFOUND') {
      // We are running on GCP.
      that.logger_.warn('Unable to retrieve GCE hostname.', err);
    }
    cb(hostname || require('os').hostname());
  });
};

TraceWriter.prototype.getInstanceId = function(cb) {
  var that = this;
  gcpMetadata.instance({
    property: 'id',
    headers: headers
  }, function(err, response, instanceId) {
    if (err && err.code !== 'ENOTFOUND') {
      // We are running on GCP.
      that.logger_.warn('Unable to retrieve GCE instance id.', err);
    }
    cb(instanceId);
  });
};

/**
 * Returns the project ID if it has been cached and attempts to load
 * it from the enviroment or network otherwise.
 *
 * @param {function(?, number):?} callback an (err, result) style callback
 */
TraceWriter.prototype.getProjectId = function(callback) {
  var that = this;
  if (that.config_.projectId) {
    callback(null, that.config_.projectId);
    return;
  }

  gcpMetadata.project({
    property: 'project-id',
    headers: headers
  }, function(err, response, projectId) {
    if (err) {
      callback(err);
      return;
    }
    that.logger_.info('Acquired ProjectId from metadata: ' + projectId);
    that.config_.projectId = projectId;
    callback(null, projectId);
  });
};

/**
 * Ensures that all sub spans of the provided spanData are
 * closed and then queues the span data to be published.
 *
 * @param {SpanData} spanData The trace to be queued.
 */
TraceWriter.prototype.writeSpan = function(spanData) {
  for (var i = 0; i < spanData.trace.spans.length; i++) {
    if (spanData.trace.spans[i].endTime === '') {
      spanData.trace.spans[i].close();
    }
  }

  // Copy properties from the default labels.
  for (var k in this.defaultLabels_) {
    if (this.defaultLabels_.hasOwnProperty(k)) {
      spanData.addLabel(k, this.defaultLabels_[k]);
    }
  }
  this.queueTrace_(spanData.trace);
};

/**
 * Buffers the provided trace to be published.
 *
 * @private
 * @param {Trace} trace The trace to be queued.
 */
TraceWriter.prototype.queueTrace_ = function(trace) {
  var that = this;

  that.getProjectId(function(err, project) {
    if (err) {
      that.logger_.info('No project number, dropping trace.');
      return; // ignore as index.js takes care of this.
    }

    trace.projectId = project;
    that.buffer_.push(JSON.stringify(trace));
    that.logger_.debug('queued trace. new size:', that.buffer_.length);

    // Publish soon if the buffer is getting big
    if (that.buffer_.length >= that.config_.bufferSize) {
      that.logger_.info('Flushing: trace buffer full');
      setImmediate(function() { that.flushBuffer_(project); });
    }
  });
};

/**
 * Flushes the buffer of traces at a regular interval
 * controlled by the flushDelay property of this
 * TraceWriter's config.
 */
TraceWriter.prototype.scheduleFlush_ = function(project) {
  this.logger_.info('Flushing: performing periodic flush');
  this.flushBuffer_(project);

  // Do it again after delay
  if (this.isActive) {
    setTimeout(this.scheduleFlush_.bind(this, project),
      this.config_.flushDelaySeconds * 1000).unref();
  }
};

/**
 * Serializes the buffered traces to be published asynchronously.
 *
 * @param {number} projectId The id of the project that traces should publish on.
 */
TraceWriter.prototype.flushBuffer_ = function(projectId) {
  if (this.buffer_.length === 0) {
    return;
  }

  // Privatize and clear the buffer.
  var buffer = this.buffer_;
  this.buffer_ = [];
  this.logger_.debug('Flushing traces', buffer);
  this.publish_(projectId, '{"traces":[' + buffer.join() + ']}');
};

/**
 * Publishes flushed traces to the network.
 *
 * @param {number} projectId The id of the project that traces should publish on.
 * @param {string} json The stringified json representation of the queued traces.
 */
TraceWriter.prototype.publish_ = function(projectId, json) {
  // TODO(ofrobots): assert.ok(this.config_.project), and stop accepting
  // projectId as an argument.
  var that = this;
  var uri = 'https://cloudtrace.googleapis.com/v1/projects/' +
    projectId + '/traces';

  var options = {
    method: 'PATCH',
    uri: uri,
    body: json,
    headers: headers
  };
  that.request(options, function(err, body, response) {
    if (err) {
      that.logger_.error('TraceWriter: error: ',
        ((response && response.statusCode) || '') + '\n' + err.stack);
    } else {
      that.logger_.info('TraceWriter: published. statusCode: ' + response.statusCode);
    }
  });
};

// Singleton
var traceWriter;

module.exports = {
  create: function(logger, config) {
    if (!traceWriter || config.forceNewAgent_) {
      traceWriter = new TraceWriter(logger, config);
    }
    return traceWriter;
  },
  get: function() {
    if (!traceWriter) {
      throw new Error('TraceWriter singleton was not initialized.');
    }
    return traceWriter;
  }
};
