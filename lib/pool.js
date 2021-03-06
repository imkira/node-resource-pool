/*
 * Copyright (c) 2013 Mario Freitas (imkira@gmail.com)
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
 * WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

var EventEmitter = require('events').EventEmitter;
var util = require('util');

var ERRORS = {
  'POOL_ACQUIRE_DURING_DRAINING': 'Cannot acquire during pool draining',
  'POOL_ACQUIRE_TIMEOUT_ERROR': 'Timeout fired while acquiring resource',
  'POOL_ACQUIRE_ABORTED_BY_DRAIN': 'Cannot acquire because pool started to drain',
  'POOL_MAX_REQUESTS_LIMIT': 'Cannot acquire due to max requests limit reached'
};

var tick = global.setImmediate || process.nextTick;

var timeNow = function() {
  return (new Date()).getTime();
};

/**
 * Create a resource pool object.
 * @constructor
 * @param options {Object} Object with options:
 * @param options.min {Number} Minimum number of objects to have ready at any time.
 * @param options.max {Number} Maximum number of objects to have ready at any time.
 * @param options.maxCreating {Number} Maximum number of resources in create-pending state to handle.
 * @param options.maxRequests {Number} Maximum number of waiting requests to handle.
 * @param options.acquireTimeout {Number} Default timeout (ms) to wait for acquire.
 * @param options.idleTimeout {Number} Timeout for idle resources (ms).
 * @param options.idleCheckInterval {Number} Reaping interval for idle resources (ms).
 * @param options.expireTimeout {Number} Timeout for expiring resources (ms).
 * @param options.expireCheckInterval {Number} Reaping interval for expired resources (ms).
 * @param options.maintenanceInterval {Number} Interval for periodic maintenance (ms).
 * @param options.maintenanceTimeout {Number} Timeout for next non-periodic maintenance (ms).
 * @param options.create {Function} Function that creates a new resource.
 * @param options.destroy {Function} Function that destroys a resource.
 * @param options.validate {Function} Function that validates a resource.
 * @param options.compare {Function} Function that compares resources by value.
 * @param options.backoff {Function} Function that returns a delay on error.
 */
var Pool = function(options) {
  EventEmitter.call(this);

  this.createResource = options.create;
  this.destroyResource = options.destroy;
  this.validateResource = options.validate || function (resource) {
    return !!resource;
  };
  this.compareResources = options.compare || function (value1, value2) {
    return (value1 === value2);
  };
  this.backoff = options.backoff;

  this.min = options.min || 0;
  this.max = options.max || 1024;
  this.maxCreating = options.maxCreating;
  this.maxRequests = options.maxRequests;
  this.acquireTimeout = options.acquireTimeout;
  this.idleTimeout = options.idleTimeout;
  this.idleCheckInterval = options.idleCheckInterval || 1000;
  this.expireTimeout = options.expireTimeout;
  this.expireCheckInterval = options.expireCheckInterval || 1000;
  this.maintenanceInterval = options.maintenanceInterval ||
    Math.min(this.idleCheckInterval, this.expireCheckInterval);
  this.maintenanceTimeout = options.maintenanceTimeout || 50;

  this.agingRequests = [];
  this.agelessRequests = [];
  this.freeResources = [];
  this.lentResources = [];
  this.creatingResourceCount = 0;
  this.destroyingResourceCount = 0;
  this.lastIdleCheckAt = 0;
  this.lastExpireCheckAt = 0;
  this.isDraining = false;

  this._maintenanceIntervalID = null;
  this.setMaintenanceInterval(this.maintenanceInterval);
  this._maintain();
};

util.inherits(Pool, EventEmitter);

/**
 * Acquire resource from the pool.
 * @param {Object} options Options for controlling resource acquisition.
 * @param {Number} options.timeout Number of milliseconds to wait for acquire.
 * @param {Function} done Callback with error and resource.
 */
Pool.prototype.acquire = function(options, done) {
  if (arguments.length === 1) {
    done = options;
    options = undefined;
  }

  this._enqueueRequest(this._createRequest(options, done));
};

/**
 * Acquire resource from the pool synchronously (if there is one).
 * @return {Object} Resource container or undefined if no resources available.
 */
Pool.prototype.acquireSync = function(options) {
  var resource = this._nextFreeResource();

  if (resource) {
    var request = this._createRequest(options);
    if (this.isDraining === true) {
      this._serveRequest(request, 'POOL_ACQUIRE_DURING_DRAINING');
    }
    else {
      this._serveRequest(request, null, resource);
      return resource.value;
    }
  }
};

/**
 * Release acquired resource.
 * @param {Object} resourceValue Value representing resource.
 */
Pool.prototype.release = function(resourceValue) {
  var i = this._getResourceIndex(this.lentResources, resourceValue);

  if (i >= 0) {
    var resource = this.lentResources[i];
    this.lentResources.splice(i, 1);
    this.emit('release', resource);
    this._storeResource(resource);
  }
};

/**
 * Destroy resource (acquired or not).
 * @param {Object} resourceValue Value representing resource.
 */
Pool.prototype.destroy = function(resourceValue) {
  var resources = this.lentResources;
  var i = this._getResourceIndex(resources, resourceValue);

  if (i < 0) {
    resources = this.freeResources;
    i = this._getResourceIndex(resources, resourceValue);
  }

  if (i >= 0) {
    var resource = resources[i];
    resources.splice(i, 1);
    this._destroyResource(resource);
  }
};

/**
 * Create a request.
 * @private
 */
Pool.prototype._createRequest = function(options, done) {
  var now = timeNow();
  options = options || {};
  return {
    originalCall: new Error(),
    done: done,
    createdAt: now,
    acquireTimeoutAt: now + (options.timeout || this.acquireTimeout)
  };
};

/**
 * Add request to the queue.
 * @private
 */
Pool.prototype._enqueueRequest = function(request) {
  this.emit('enqueueRequest', request);
  if (this.isDraining === true) {
    this._serveRequest(request, 'POOL_ACQUIRE_DURING_DRAINING');
  }
  else if ((this.agelessRequests.length + this.agingRequests.length) >= this.maxRequests) {
    this._serveRequest(request, 'POOL_MAX_REQUESTS_LIMIT');
  }
  else {
    this._insertRequestByAcquireTimeout(request);
    this._scheduleMaintainance();
  }
};

/**
 * Insert request in order of acquireTimeoutAt.
 * @private
 */
Pool.prototype._insertRequestByAcquireTimeout = function(request) {
  if (isNaN(request.acquireTimeoutAt)) {
    this.agelessRequests.push(request);
  }
  else {
    var i = this.agingRequests.length;
    while ((i > 0) &&
        (request.acquireTimeoutAt < this.agingRequests[i - 1].acquireTimeoutAt)) {
      --i;
    }
    this.agingRequests.splice(i, 0, request);
  }
};

/**
 * Get next available resource.
 * @private
 */
Pool.prototype._nextFreeResource = function() {
  var resource;

  while ((resource = this.freeResources.shift())) {
    if (this.validateResource(resource)) {
      return resource;
    }
    this._destroyResource(resource);
  }
};

/**
 * Serve request by calling client back with error and resource.
 * @private
 */
Pool.prototype._serveRequest = function(request, errCode, resource) {
  if (errCode) {
    var err = new Error(ERRORS[errCode]);
    err.code = errCode;
    err.originalStack = request.originalCall.stack;
    this.emit('serveError', err, request);
    if (request.done) {
      request.done(err);
    }
  }
  else {
    resource.request = request;
    this.lentResources.push(resource);
    this.emit('serveSuccess', request, resource.value);
    if (request.done) {
      request.done(null, resource.value);
    }
  }
};

/**
 * Serves pending aging requests.
 * @private
 */
Pool.prototype._serveAgingRequests = function() {
  var now = timeNow();
  var resource, request;

  while (this.agingRequests.length > 0) {
    request = this.agingRequests[0];

    // request did time out?
    if (now > request.acquireTimeoutAt) {
      this.agingRequests.shift();
      this._serveRequest(request, 'POOL_ACQUIRE_TIMEOUT_ERROR');
    }
    else {
      resource = this._nextFreeResource();
      if (!resource) {
        break;
      }
      this.agingRequests.shift();
      this._serveRequest(request, null, resource);
    }
  }
};

/**
 * Serves pending ageless requests.
 * @private
 */
Pool.prototype._serveAgelessRequests = function() {
  var resource, request;

  while (this.agelessRequests.length > 0) {
    resource = this._nextFreeResource();
    if (!resource) {
      break;
    }
    var before = this.agelessRequests[0];
    request = this.agelessRequests.shift();
    this._serveRequest(request, null, resource);
  }
};

/**
 * Create resource.
 * @private
 */
Pool.prototype._createResource = function() {
  var called = false;
  var that = this;

  ++this.creatingResourceCount;
  this.createResource(function(err, value) {
    if (called === false) {
      called = true;
      if (err) {
        that.emit('createError', err);
        if (that.backoff) {
          setTimeout(function() {
            --that.creatingResourceCount;
          }, that.backoff());
        }
        else {
          --that.creatingResourceCount;
        }
      }
      else {
        --that.creatingResourceCount;

        var now = timeNow();
        that.emit('createSuccess', value);
        that._storeResource({
          value: value,
          createdAt: now,
          expiresAt: now + that.expireTimeout
        });
      }
    }
  });
};

/**
 * Destroy resource.
 * @private
 */
Pool.prototype._destroyResource = function(resource) {
  var that = this;
  var called = false;

  ++this.destroyingResourceCount;
  this.emit('destroy', resource);
  this.destroyResource(resource, function() {
    if (called === false) {
      called = true;
      --that.destroyingResourceCount;
    }
  });
};

/**
 * Get lent resource index by resource value.
 * @private
 */
Pool.prototype._getResourceIndex = function(resources, resourceValue) {
  for (var i = resources.length - 1; i >= 0; --i) {
    if (this.compareResources(resources[i].value, resourceValue)) {
      return i;
    }
  }
  return -1;
};

/**
 * Store resource in pool.
 * @private
 */
Pool.prototype._storeResource = function(resource) {
  if ((this.isDraining === false) && (this.validateResource(resource))) {
    delete resource.request;
    resource.idleAt = timeNow();
    this.freeResources.push(resource);
    this._scheduleMaintainance();
  }
  else {
    this._destroyResource(resource);
  }
};

/**
 * Count total number of resources used.
 * @private
 */
Pool.prototype._countResources = function() {
  return this.freeResources.length + this.lentResources.length +
    this.creatingResourceCount + this.destroyingResourceCount;
};

/**
 * Create resources as required.
 * @private
 */
Pool.prototype._createResources = function() {
  var count = this._countResources();
  var extra = (this.agelessRequests.length + this.agingRequests.length);

  // ensure required number of resources
  if ((count < this.min) && (extra < this.min)) {
    extra = this.min;
  }

  // resources in creation + currently acquired resources should not
  // surpass maximum allowed resources.
  if ((count + extra) > this.max) {
    extra = this.max - count;
  }

  extra -= this.creatingResourceCount;

  // limit create burst
  if (this.maxCreating > 0) {
    var available = this.maxCreating - this.creatingResourceCount;
    extra = (extra > available) ? available : extra;
  }

  // create resources
  while (extra-- > 0) {
    this._createResource();
  }
};

/**
 * Destroy resources given a timestamp key and timeout.
 * @private
 */
Pool.prototype._destroyDeadResources = function(key, timeout) {
  var now = timeNow();
  var i, dead = [];

  for (i = this.freeResources.length - 1; i >= 0; --i) {
    var resource = this.freeResources[i];

    // resource has been around for too long
    if (now > (resource[key] + timeout)) {
      this.freeResources.splice(i, 1);
      dead.push(resource);
    }
  }

  // destroy resources
  for (i = dead.length - 1; i >= 0; --i)
  {
    this._destroyResource(dead[i]);
  }
};

/**
 * Destroy idle resources.
 * @private
 */
Pool.prototype._destroyIdleResources = function() {
  if ((this.idleTimeout > 0) &&
      (timeNow() > (this.lastIdleCheckAt + this.idleCheckInterval))) {
    // destroy idle resources
    this._destroyDeadResources('idleAt', this.idleTimeout);
    this.lastIdleCheckAt = timeNow();
  }
};

/**
 * Destroy expired resources.
 * @private
 */
Pool.prototype._destroyExpiredResources = function() {
  if ((this.expireTimeout > 0) &&
      (timeNow() > (this.lastExpireCheckAt + this.expireCheckInterval))) {
    // destroy expired resources
    this._destroyDeadResources('expiresAt', 0);
    this.lastExpireCheckAt = timeNow();
  }
};

/**
 * Update maintenance interval
 */
Pool.prototype.setMaintenanceInterval = function(interval) {
  if (this._maintenanceIntervalID !== null) {
    clearInterval(this._maintenanceIntervalID);
  }
  this.maintenanceInterval = interval;
  this._maintenanceIntervalID = setInterval(this._maintain.bind(this), interval);
};

/**
 * Maintain pool.
 * @private
 */
Pool.prototype._maintain = function() {
  if ((this.isDraining === true) || (this.isMaintaining === true)) {
    return;
  }

  this.isMaintaining = true;

  // destroy expired resources
  this._destroyExpiredResources();

  // destroy idle resources
  this._destroyIdleResources();

  // serve aging requests first
  this._serveAgingRequests();

  // serve ageless requests
  this._serveAgelessRequests();

  // ensure creation of resources
  this._createResources();

  this.isMaintaining = false;
};

/**
 * Perform maintenance and finish maintenance
 */
Pool.prototype._scheduledMaintain = function() {
  this._maintain();
  this.isMaintenanceScheduled = false;
};

/**
 * Schedule maintenance operations as soon as possible.
 * @private
 */
Pool.prototype._scheduleMaintainance = function() {
  if (this.isMaintenanceScheduled !== true) {
    this.isMaintenanceScheduled = true;
    setTimeout(this._scheduledMaintain.bind(this), this.maintenanceTimeout);
  }
};

/**
 * Destroy all free resources, cancels all requests and waits for
 * lent resources to complete.
 * @param {Function}
 */
Pool.prototype.drain = function(done) {
  var request, resource;

  if (this.isDraining === false) {
    this.isDraining = true;

    if (this._maintenanceIntervalID !== null) {
      clearInterval(this._maintenanceIntervalID);
      this._maintenanceIntervalID = null;
    }

    while ((request = this.agingRequests.pop())) {
      this._serveRequest(request, 'POOL_ACQUIRE_ABORTED_BY_DRAIN');
    }

    while ((request = this.agelessRequests.pop())) {
      this._serveRequest(request, 'POOL_ACQUIRE_ABORTED_BY_DRAIN');
    }

    while ((resource = this.freeResources.pop())) {
      this._destroyResource(resource);
    }
  }

  this._waitDrain(done);
};

/**
 * Wait for drain to complete.
 * @private
 */
Pool.prototype._waitDrain = function(done) {
  if (this._countResources() === 0) {
    this.emit('drain');
    if (done) {
      tick(done);
    }
  }
  else {
    tick(this._waitDrain.bind(this, done));
  }
};

/**
 * Create a Pool object.
 */
Pool.create = function(options) {
  return new Pool(options);
};

module.exports = Pool;
