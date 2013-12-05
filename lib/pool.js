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

  this.requests = [];
  this.freeResources = [];
  this.lentResources = [];
  this.creatingResourceCount = 0;
  this.destroyingResourceCount = 0;
  this.lastIdleCheckAt = 0;
  this.lastExpireCheckAt = 0;
  this.isDraining = false;

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
 * Add request to the back of the queue.
 * @private
 */
Pool.prototype._enqueueRequest = function(request) {
  this.emit('enqueueRequest', request);
  if (this.isDraining === true) {
    this._serveRequest(request, 'POOL_ACQUIRE_DURING_DRAINING');
  }
  else if (this.requests.length >= this.maxRequests) {
    this._serveRequest(request, 'POOL_MAX_REQUESTS_LIMIT');
  }
  else {
    this.requests.push(request);
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
 * Serves pending requests.
 * @private
 */
Pool.prototype._serveRequests = function() {
  var now = timeNow();
  var i, finished = [];

  for (i = this.requests.length - 1; i >= 0; --i) {
    var resource, request = this.requests[i];

    // request did time out?
    if (now > request.acquireTimeoutAt) {
      this.requests.splice(i, 1);
      finished.push([request, 'POOL_ACQUIRE_TIMEOUT_ERROR']);
    }
    else {
      resource = this._nextFreeResource();
      if (resource) {
        this.requests.splice(i, 1);
        finished.push([request, null, resource]);
      }
    }
  }

  // call back waiting requests
  for (i = finished.length - 1; i >= 0; --i)
  {
    this._serveRequest.apply(this, finished[i]);
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
  var extra = this.requests.length;

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
    extra = Math.min(this.maxCreating - this.creatingResourceCount, extra);
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
 * Maintain pool.
 */
Pool.prototype._maintain = function() {
  if (this.isDraining === true) {
    return;
  }

  // destroy expired resources
  this._destroyExpiredResources();

  // destroy idle resources
  this._destroyIdleResources();

  // serve requests
  this._serveRequests();

  // ensure creation of resources
  this._createResources();

  // schedule next maintenance
  tick(this._maintain.bind(this));
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

    while ((request = this.requests.pop())) {
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
