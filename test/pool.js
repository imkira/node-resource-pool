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

var should = require('should');
var Pool = require('../lib/pool');

var createPool = function(opts, timeout) {
  var val = 1;
  opts.create = function(done) {
    var obj = { val: val++ };
    if (timeout >= 0) {
      setTimeout(function() {
        done(null, obj);
      }, timeout);
    }
    else {
      done(null, obj);
    }
  };
  opts.destroy = function(resource, done) {
    done();
  };
  return new Pool(opts);
};

var expectError = function(args, code) {
  var err = args[0];
  should.exist(err);
  err.should.be.an.instanceOf(Error);
  should.strictEqual(err.code, code);
  should.strictEqual(args.length, 1);
};

describe('Pool', function() {
  describe('#acquire', function() {
    it('should fail if timeout is negative', function(done) {
      var pool = createPool({}, -1);
      var callCount = 0;
      pool.acquire({timeout: -1}, function(err, resource) {
        ++callCount;
        should.strictEqual(callCount, 1);
        expectError(arguments, 'POOL_ACQUIRE_TIMEOUT_ERROR');
        setTimeout(function() {
          should.strictEqual(callCount, 1);
          pool.drain(done);
        }, 100);
      });
    });

    it('should fail if acquire is called after drain', function(done) {
      var pool = createPool({}, -1);
      var callCount = 0;
      pool.drain();
      pool.acquire({timeout: 1000}, function(err, resource) {
        ++callCount;
        should.strictEqual(callCount, 1);
        expectError(arguments, 'POOL_ACQUIRE_DURING_DRAINING');
        setTimeout(function() {
          should.strictEqual(callCount, 1);
          pool.drain(done);
        }, 100);
      });
    });

    it('should time out if acquire itself takes too long', function(done) {
      var pool = createPool({}, 500);
      var callCount = 0;
      pool.acquire({timeout: 300}, function(err, resource) {
        ++callCount;
        should.strictEqual(callCount, 1);
        expectError(arguments, 'POOL_ACQUIRE_TIMEOUT_ERROR');
        setTimeout(function() {
          should.strictEqual(callCount, 1);
          pool.drain(done);
        }, 100);
      });
    });

    it('should fail if request count exceeds limit', function(done) {
      var pool = createPool({maxRequests:1}, 300);
      var callCount = 0;
      pool.acquire(function(err, resource) {
        ++callCount;
        should.strictEqual(callCount, 2);
        should.not.exist(err);
        pool.release(resource);
        setTimeout(function() {
          should.strictEqual(callCount, 2);
          pool.release(resource);
          pool.drain(done);
        }, 100);
      });
      pool.acquire(function(err, resource) {
        ++callCount;
        should.strictEqual(callCount, 1);
        expectError(arguments, 'POOL_MAX_REQUESTS_LIMIT');
      });
    });

    it('should wait if specified timeout is positive', function(done) {
      var pool = createPool({}, 300);
      var callCount = 0;
      pool.acquire({timeout: 1000}, function(err, resource) {
        ++callCount;
        should.strictEqual(callCount, 1);
        should.not.exist(err);
        setTimeout(function() {
          should.strictEqual(callCount, 1);
          pool.release(resource);
          pool.drain(done);
        }, 100);
      });
    });

    it('should update idleAt when resource is reused', function(done) {
      var pool = createPool({min:1, idleTimeout:500, idleCheckInterval:50}, 10);
      pool.acquire({timeout: 1000}, function(err, resource) {
        should.not.exist(err);
        resource.should.eql({val: 1});
        should.strictEqual(pool.lentResources.length, 1);
        var acquiredResource = pool.lentResources[0];
        var idleAt = acquiredResource.idleAt;
        (acquiredResource.idleAt - acquiredResource.createdAt).should.be.below(50);
        setTimeout(function() {
          pool.release(resource);
          setTimeout(function() {
            pool.acquire({timeout: 1000}, function(err, resource2) {
              should.not.exist(err);
              resource2.should.eql({val: 1});
              should.strictEqual(resource, resource2);
              should.strictEqual(pool.lentResources.length, 1);
              should.strictEqual(pool.lentResources[0], acquiredResource);
              (acquiredResource.idleAt - idleAt).should.be.above(99);
              acquiredResource.idleAt.should.be.above(acquiredResource.createdAt);
              pool.release(resource2);
              setTimeout(function() {
                pool.acquire({timeout: 1000}, function(err, resource3) {
                  should.not.exist(err);
                  resource3.should.eql({val: 1});
                  should.strictEqual(resource, resource3);
                  should.strictEqual(pool.lentResources.length, 1);
                  should.strictEqual(pool.lentResources[0], acquiredResource);
                  (acquiredResource.idleAt - idleAt).should.be.above(99);
                  acquiredResource.idleAt.should.be.above(acquiredResource.createdAt);
                  pool.release(resource3);
                  setTimeout(function() {
                    pool.acquire({timeout: 1000}, function(err, resource4) {
                      should.not.exist(err);
                      resource4.should.eql({val: 2});
                      should.notStrictEqual(resource, resource4);
                      should.strictEqual(pool.lentResources.length, 1);
                      acquiredResource = pool.lentResources[0];
                      should.strictEqual(acquiredResource.idleAt, acquiredResource.createdAt);
                      setTimeout(function() {
                        pool.release(resource4);
                        pool.drain(done);
                      }, 100);
                    });
                  }, 600);
                });
              }, 300);
            });
          }, 300);
        }, 100);
      });
    });

    it('should not update expiresAt even if resource is reused', function(done) {
      var pool = createPool({min:1, expireTimeout:500, expireCheckInterval:50}, 10);
      pool.acquire({timeout: 1000}, function(err, resource) {
        should.not.exist(err);
        resource.should.eql({val: 1});
        should.strictEqual(pool.lentResources.length, 1);
        var acquiredResource = pool.lentResources[0];
        var expiresAt = acquiredResource.expiresAt;
        should.strictEqual(acquiredResource.expiresAt, (acquiredResource.createdAt + 500));
        setTimeout(function() {
          pool.release(resource);
          setTimeout(function() {
            pool.acquire({timeout: 1000}, function(err, resource2) {
              should.not.exist(err);
              resource2.should.eql({val: 1});
              should.strictEqual(resource, resource2);
              should.strictEqual(pool.lentResources.length, 1);
              should.strictEqual(pool.lentResources[0], acquiredResource);
              should.strictEqual(acquiredResource.expiresAt, expiresAt);
              pool.release(resource2);
              setTimeout(function() {
                pool.acquire({timeout: 1000}, function(err, resource3) {
                  should.not.exist(err);
                  resource3.should.eql({val: 2});
                  should.notStrictEqual(resource, resource3);
                  should.strictEqual(pool.lentResources.length, 1);
                  acquiredResource = pool.lentResources[0];
                  setTimeout(function() {
                    pool.release(resource3);
                    pool.drain(done);
                  }, 100);
                });
              }, 300);
            });
          }, 300);
        }, 100);
      });
    });

    it('should acquire inside acquire', function(done) {
      var pool = createPool({}, 300);
      var callCount = 0;
      pool.acquire({timeout: 1000}, function(err, resource) {
        ++callCount;
        should.strictEqual(callCount, 1);
        should.not.exist(err);
        pool.acquire({timeout: 1000}, function(err2, resource2) {
          ++callCount;
          should.strictEqual(callCount, 2);
          should.not.exist(err2);
          setTimeout(function() {
            should.strictEqual(callCount, 2);
            pool.release(resource2);
            pool.release(resource);
            pool.drain(done);
          }, 100);
        });
      });
    });

    it('should reserve min resources without acquire', function(done) {
      var pool = createPool({min:100, max:1000}, 300);
      setTimeout(function() {
        should.strictEqual(pool.freeResources.length, 100);
        pool.drain(done);
      }, 300);
    });

    it('should handle heavy load', function(done) {
      var pool = createPool({max: 1000}, 0);
      var callCount = 0;
      for (var i = 0; i < 10000; ++i) {
        pool.acquire({timeout: 1000}, function(err, resource) {
          ++callCount;
          should.not.exist(err);
          should.exist(resource);
          setTimeout(function() {
            pool.release(resource);
          }, 10);
        });
      }
      setTimeout(function() {
        pool.drain(function() {
          should.strictEqual(callCount, 10000);
          done();
        });
      }, 1000);
    });

    it('should cap resource creation under heavy load', function(done) {
      var pool = createPool({max: 1000, maxCreating:10}, 800);
      var acquired = [], capped = 0;
      var callCount = 0;
      for (var i = 0; i < 1000; ++i) {
        pool.acquire(function(err, resource) {
          ++callCount;
          if (err) {
            should.not.exist(resource);
            ++capped;
          }
          else {
            should.exist(resource);
            acquired.push(resource);
          }
        });
      }
      setTimeout(function() {
        should.strictEqual(callCount, 10);
        should.strictEqual(pool.freeResources.length, 0);
        should.strictEqual(pool.lentResources.length, acquired.length);
        should.strictEqual(acquired.length, 10);
        while (acquired.length > 0) {
          pool.destroy(acquired.pop());
        }
        pool.drain(function() {
          should.strictEqual(callCount, 1000);
          done();
        });
      }, 1300);
    });
  });

  describe('#aquireSync', function() {
    it('should return undefined when no resources are available', function(done) {
      var pool = createPool({}, -1);
      should.strictEqual(pool._countResources(), 0);
      should.strictEqual(pool.acquireSync(), undefined);
      should.strictEqual(pool._countResources(), 0);
      pool.drain(done);
    });

    it('should return resource immediately when available', function(done) {
      var pool = createPool({min:5}, -1);

      setTimeout(function() {
        should.strictEqual(pool._countResources(), 5);
        should.strictEqual(pool.freeResources.length, 5);
        should.strictEqual(pool.lentResources.length, 0);

        var resource = pool.acquireSync();

        resource.should.eql({val: 1});
        should.strictEqual(pool._countResources(), 5);
        should.strictEqual(pool.freeResources.length, 4);
        should.strictEqual(pool.lentResources.length, 1);

        var resource2 = pool.acquireSync();

        resource2.should.eql({val: 2});
        should.strictEqual(pool._countResources(), 5);
        should.strictEqual(pool.freeResources.length, 3);
        should.strictEqual(pool.lentResources.length, 2);

        setTimeout(function() {
          var resource3 = pool.acquireSync();

          resource3.should.eql({val: 3});
          should.strictEqual(pool._countResources(), 5);
          should.strictEqual(pool.freeResources.length, 2);
          should.strictEqual(pool.lentResources.length, 3);

          pool.release(resource3);
          pool.release(resource2);
          pool.release(resource);
          should.strictEqual(pool._countResources(), 5);
          should.strictEqual(pool.freeResources.length, 5);
          should.strictEqual(pool.lentResources.length, 0);

          pool.drain(done);
        }, 200);
      }, 200);
    });

    it('should fail if acquire is called after drain', function(done) {
      var pool = createPool({min:5}, 500);
      should.strictEqual(pool._countResources(), 5);
      should.strictEqual(pool.freeResources.length, 0);
      should.strictEqual(pool.lentResources.length, 0);
      setTimeout(function() {
        pool.drain();
        should.strictEqual(pool.acquireSync(), undefined);
        pool.drain(done);
      }, 100);
    });
  });

  describe('#drain', function() {
    it('should abort pending acquires', function(done) {
      var pool = createPool({}, -1);
      var callCount = 0;
      pool.drain();
      pool.acquire({timeout: 1000}, function(err, resource) {
        ++callCount;
        should.strictEqual(callCount, 1);
        expectError(arguments, 'POOL_ACQUIRE_DURING_DRAINING');
        setTimeout(function() {
          should.strictEqual(callCount, 1);
          pool.drain(done);
        }, 100);
      });
    });

    it('should only call back when all lent resources are released', function(done) {
      var pool = createPool({}, 300);
      var released = false;
      pool.acquire({timeout: 1000}, function(err, resource) {
        should.not.exist(err);
        pool.drain(function() {
          should.strictEqual(released, true);
          done();
        });
        setTimeout(function() {
          released = true;
          pool.release(resource);
        }, 200);
      });
    });

    it('should only call back when all lent resources are destroyed', function(done) {
      var pool = createPool({}, 300);
      var destroyed = false;
      pool.acquire({timeout: 1000}, function(err, resource) {
        should.not.exist(err);
        pool.drain(function() {
          should.strictEqual(destroyed, true);
          done();
        });
        setTimeout(function() {
          destroyed = true;
          pool.destroy(resource);
        }, 200);
      });
    });
  });

  describe('#_maintain', function() {
    it('should auto create minimum resources', function(done) {
      var pool = createPool({min:5, max:100}, 10);

      should.strictEqual(pool.freeResources.length, 0);
      should.strictEqual(pool.lentResources.length, 0);
      setTimeout(function() {
        should.strictEqual(pool.freeResources.length, 5);
        should.strictEqual(pool.lentResources.length, 0);
        pool.drain();
        setTimeout(function() {
          should.strictEqual(pool.freeResources.length, 0);
          should.strictEqual(pool.lentResources.length, 0);
          pool.drain(done);
        }, 200);
      }, 100);
    });

    it('should create resources on demand', function(done) {
      var pool = createPool({min:0, max:100}, 300);

      should.strictEqual(pool.freeResources.length, 0);
      should.strictEqual(pool.lentResources.length, 0);
      setTimeout(function() {
        should.strictEqual(pool.freeResources.length, 0);
        should.strictEqual(pool.lentResources.length, 0);
        pool.acquire(function(err, resource) {
          should.not.exist(err);
          should.strictEqual(pool.freeResources.length, 0);
          should.strictEqual(pool.lentResources.length, 1);
          setTimeout(function() {
            should.strictEqual(pool.freeResources.length, 0);
            should.strictEqual(pool.lentResources.length, 1);
            pool.release(resource);
            pool.drain(done);
          }, 300);
        });
      }, 400);
    });

    it('should recycle idle resources', function(done) {
      var pool = createPool({min:10, idleTimeout:500, idleCheckInterval:50}, 10);

      should.strictEqual(pool.freeResources.length, 0);
      should.strictEqual(pool.lentResources.length, 0);
      setTimeout(function() {
        should.strictEqual(pool.freeResources.length, 10);
        for (var i = 0; i < pool.freeResources.length; ++i) {
          should.strictEqual(pool.freeResources[i].value.val, i + 1);
        }
        should.strictEqual(pool.lentResources.length, 0);
        setTimeout(function() {
          should.strictEqual(pool.freeResources.length, 10);
          for (var i = 0; i < pool.freeResources.length; ++i) {
            should.strictEqual(pool.freeResources[i].value.val, i + 11);
          }
          should.strictEqual(pool.lentResources.length, 0);
          pool.drain(done);
        }, 500);
      }, 300);
    });

    it('should auto release idle resources', function(done) {
      var pool = createPool({idleTimeout:500, idleCheckInterval:50}, 10);

      should.strictEqual(pool.freeResources.length, 0);
      should.strictEqual(pool.lentResources.length, 0);
      pool.acquire(function(err, resource) {
        should.not.exist(err);
        should.strictEqual(pool.freeResources.length, 0);
        should.strictEqual(pool.lentResources.length, 1);
        pool.release(resource);
        setTimeout(function() {
          should.strictEqual(pool.freeResources.length, 1);
          should.strictEqual(pool.lentResources.length, 0);
          setTimeout(function() {
            should.strictEqual(pool.freeResources.length, 0);
            should.strictEqual(pool.lentResources.length, 0);
            pool.drain(done);
          }, 500);
        }, 100);
      });
    });
  });
});
