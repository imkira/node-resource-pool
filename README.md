node-resource-pool
==================

[![Build Status](https://travis-ci.org/imkira/node-resource-pool.png)](https://travis-ci.org/imkira/node-resource-pool)

This is a resource pool implementation for node.
You can use it to handle pool connections, files, and other kinds of resources
for which creation is an expensive operation.

## Requirements

* node (tested on 0.6.x and above but it should work previous versions too).

## Installation

In your package.json's dependencies add:

```
"node-resource-pool": "git://github.com/imkira/node-resource-pool"
```

or simply type from the command line:

```
npm install git://github.com/imkira/node-resource-pool
```

If you append ```--save```, node-resource-pool will be automatically added to
your package.json file.

## Usage

Below is an example on how to use node-resource-pool with node-mysql.

```
var resourcePool = require('node-resource-pool');
var mysql = require('mysql');

var myPool = null;

myPool = resourcePool.create({
  create: function(done) { // callback for creating a resource (required)
    var connection = mysql.createConnection({
      host : 'localhost',
      user : 'root',
      password : 'password'
    });

    // you may want to remove the connection from the pool if some error happens
    connection.on('error', function() {
      myPool.destroy(connection);
    });

    // you may want to remove the connection from the pool if it is terminated
    connection.on('end', function() {
      myPool.destroy(connection);
    });

    connection._isValid = true;
    connection.connect();

    // done accepts error, resourceValue
    done(null, connection);
  },
  destroy: function(connection, done) { // callback for destroying a resource (required)
    // done does not accept parameters but needs to be called
    try {
      connection.destroy();
    }
    catch (err) {
    }
    done();
  },
  validate: function(resource) { // callback for validating a resource (optional)
    // should return true if resource is valid, or false otherwise
    return ((resource) && (resource.value) && (resource.value._isValid === true));
  },
  compare: function(connection1, connection2) { // callback for comparing resources (optional)
    return (connection1 === connection2);
  },
  backoff: function() { // function that returns the delay time to be placed on resource creation failure (optional)
    // Delays resource creation failure by a time between 100 and 1000 milliseconds.
    // If an error peak happens, backoff time will temporarily limit the rate at which requets are served.
    // For instance, assume you have a pool that has 0 free resources and that you are currently disconnected
    // from your database server. If you get a peak of requests to the pool,
    // all acquire operations will fail immediately as soon as the connection
    // object fails to connect but it will still be considered in
    // "creation-pending" state. If you have a limit on maxCreating, new requests
    // will be queued rather than immediately served. If in turn you have
    // maxRequests set to a reasonable value, when too many requests pile up
    // due to long periods of failure, requests will be immediately denied.
    return 100 + Math.floor(Math.random() * 900);
  },
  min: 5, // minimum number of objects to have ready at any time (optional, default: 0)
  max: 500, // maximum number of objects to have ready at any time (optional, default: unlimited)
  maxCreating: 100, // maximum number of resources in creation-pending state to handle (optional, default: unlimited)
  maxRequests: 1000, // maximum number of (unserved) waiting requests to queue, above which requests are automatically denied (optional, default: unlimited)
  acquireTimeout: 5000, // default timeout to wait for acquire (optional, default: unlimited)
  idleTimeout: 60000, // specify time after which unused (idle) resources get automatically destroyed (optional, default: disabled)
  idleCheckInterval: 1000, // interval used for checking whether a given resource is idle or not (optional, default: 1000)
  expireTimeout: 300000, // specify the timer that is placed on a given resource when it is created; if resource is not being used and this time is reached the object is automatically destroyed (optional, default: disabled)
  expireCheckInterval: 1000 // interval used for checking whether a given resource is expired or not (optional, default: 1000)
});

myPool.acquire(function(err, connection) {
  if (err) {
    console.log('error', err);
  }
  else {
    console.log('resource acquired');
    // do someting with connection
    setTimeout(function() {
      console.log('we dont need this resource anymore, release it to the pool');
      myPool.release(connection);
    }, 1000);
  }
});

myPool.acquire(function(err, connection) {
  if (err) {
    console.log('error', err);
  }
  else {
    console.log('resource acquired');
    // if some error happens with the connection
    setTimeout(function() {
      // For instance, assume there was a problem with the connection and you
      // want to destroy it, rather than releasing it to the pool and getting
      // re-acquired.
      console.log('some error happened, let us destroy this resource');
      myPool.destroy(connection);
    }, 1000);
  }
});

// drain cancels unserved requests, so we wait 1 second before doing so or the
// previous acquire is cancelled.
setTimeout(function() {
  console.log('start draining');
  myPool.drain(function() {
    console.log('finished draining');
  });
}, 1000);
```

All times are interpreted in milliseconds.

## Yet another resource pool? Why?

I know there are many resource pool implementations and I found myself using
coopernurse's node-pool (thanks!) for some time. But after a while I decided to
add my own features, to be in control of my pool just like I wanted.
That being said, it doesn't mean this is cooler or better than other
implementations. Anyway, use it if you think it fits your needs.

## Contribute

* Found a bug?
* Want to contribute and add a new feature?

Please fork this project and send me a pull request!

## License

node-resource-pool is licensed under the MIT license:

www.opensource.org/licenses/MIT

## Copyright

Copyright (c) 2013 Mario Freitas. See
[LICENSE.txt](http://github.com/imkira/node-resource-pool/blob/master/LICENSE.txt)
for further details.
