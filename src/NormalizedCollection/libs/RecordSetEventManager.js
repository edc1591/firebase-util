'use strict';

var SnapshotFactory = require('./SnapshotFactory');
var util = require('../../common');

/**
 * Monitors the references attached to a RecordSet and maintains a cache of
 * current snapshots (inside RecordList below). Any time there is an update, this calls
 * RecordSet.trigger() to notify event listeners.
 *
 * @param parentRec
 * @constructor
 */
function RecordSetEventManager(parentRec) {
  var pm = parentRec.getPathManager();
  this.masterRef = pm.first().ref();
  this.url = this.masterRef.toString();
  this.recList = new RecordList(parentRec, this.url);
  this.running = false;
}

RecordSetEventManager.prototype = {
  start: function() {
    if( !this.running ) {
      util.log('RecordSetEventManager: Loading normalized records from master list %s', this.url);
      this.running = true;
      this.masterRef.on('child_added',   this._add,    this);
      this.masterRef.on('child_removed', this._remove, this);
      this.masterRef.on('child_moved',   this._move,   this);
      // make sure all existing keys are loaded into memory before we let recList trigger value events
      this.masterRef.once('value', this.recList.masterPathLoaded, this.recList);
    }
    return this;
  },

  stop: function() {
    if( this.running ) {
      util.log('RecordSetEventManager: Stopped monitoring master list %s', this.url);
      this.running = false;
      this.masterRef.off('child_added',   this._add,    this);
      this.masterRef.off('child_removed', this._remove, this);
      this.masterRef.off('child_moved',   this._move,   this);
      this.recList.unloaded();
    }
    return this;
  },

  _add: function(snap, prevChild) {
    this.recList.add(snap.key, prevChild);
  },

  _remove: function(snap) {
    this.recList.remove(snap.key);
  },

  _move: function(snap, prevChild) {
    this.recList.move(snap.key, prevChild);
  }
};

function RecordList(observable, url) {
  this.obs = observable;
  this.url = url;
  this._reset();
}

RecordList.prototype = {
  add: function(key, prevChild) {
    util.log.debug('RecordList.add: key=%s, prevChild=%s', key, prevChild);
    var rec = this.obs.child(key);
    var fn = util.bind(this._valueUpdated, this, key);
    this.loading[key] = {rec: rec, prev: prevChild, fn: fn, unwatch: function() { rec.unwatch('value', fn); }};
    if( !this.loadComplete ) {
      this.initialKeysLeft.push(key);
    }
    rec.watch('value', fn);
  },

  remove: function(key) {
    util.log.debug('RecordList.remove: key=%s', key);
    var oldSnap = this._dropRecord(key);
    if( oldSnap !== null ) {
      this._notify('child_removed', key, oldSnap);
    }
  },

  move: function(key, prevChild) {
    if(util.has(this.recs, key)) {
      var currPos = util.indexOf(this.recIds, key);
      this.recIds.splice(currPos, 1);
      this._putAfter(key, prevChild);
      this._notify('child_moved', key);
    }
  },

  masterPathLoaded: function() {
    util.log.debug('RecordList: Initial data has been loaded from master list at %s', this.url);
    this.masterLoaded = true;
    if( this._checkLoadState() ) {
      this._notifyValue();
    }
  },

  unloaded: function() {
    this._reset();
  },

  findKey: function(key) {
    return util.indexOf(this.recIds, key);
  },

  _reset: function() {
    util.each(this.recs, function(rec, key) {
      this.remove(key);
    }, this);
    util.each(this.filtered, function(rec, key) {
      this._dropRecord(key);
    }, this);
    util.each(this.loading, function(rec, key) {
      this._dropRecord(key);
    }, this);
    this.recs = {};
    this.recIds = [];
    this.snaps = {};
    this.loading = {};
    this.filtered = {};
    this.loadComplete = false;
    this.initialKeysLeft = [];
    this.masterLoaded = false;
  },

  _valueUpdated: function(key, snap) {
    var rec;
    this.snaps[key] = snap;
    if(util.has(this.loading, key)) {
      // record has finished loading and merging paths
      rec = this.loading[key];
      delete this.loading[key];
      this._processAdd(snap, rec);
    }
    else if(util.has(this.recs, key)) {
      rec = this.recs[key];
      this._processChange(snap, rec);
    }
    else if(util.has(this.filtered, key)) {
      if( snap.val() !== null && this.obs.filters.test(snap.val(), key, snap.getPriority()) ) {
        // the record data has changed and it is no longer part of the filtered
        // content, so treat it as a newly added record
        rec = this.filtered[key];
        delete this.filtered[key];
        util.log('RecordList: Unfiltered key %s', key);
        this._processAdd(snap, rec);
      }
    }
    else {
      util.log('RecordList: Orphan key %s ignored. Probably a concurrent edit.', key);
    }
  },

  _processAdd: function(snap, rec) {
    var key = snap.key();
    if( this.obs.filters.test(snap.val(), key, snap.getPriority()) ) {
      this.recs[key] = rec;
      this._putAfter(key, rec.prev);
      this._notify('child_added', key);
    }
    else {
      util.log('RecordList: Filtered key %s', key);
      this.filtered[key] = rec;
    }
    if( this._checkLoadState(key) ) {
      this._notifyValue();
    }
  },

  _processChange: function(snap, rec) {
    // null records are valid at the record level and can trigger value events, but at
    // the Set level, they mean the record is in the process of being deleted so we
    // ignore the value event here
    if( snap.val() !== null ) {
      var key = snap.key();
      if( this.obs.filters.test(snap.val(), key, snap.getPriority()) ) {
        // a changed record that has not been filtered
        this._notify('child_changed', key);
      }
      else {
        // record changes caused it to become filtered, so treat it as a removed rec
        // however, we'll continue to watch it for changes so it can be unfiltered later
        delete this.recs[key];
        this.filtered[key] = rec;
        this._notify('child_removed', key, this.snaps[key]);
      }
    }
  },

  _notify: function(event, key, oldSnap) {
    var prev;
    if( event === 'child_added' || event === 'child_moved' ) {
      prev = this._getPrevChild(key);
    }
    util.log('RecordList._notify: event=%s, key=%s, prev=%s', event, key, prev);
    var factory = new SnapshotFactory(event, key, oldSnap||this.snaps[key], prev);
    this.obs.trigger(factory);
    this._notifyValue();
  },

  _notifyValue: function() {
    if( this.loadComplete ) {
      util.log.debug('RecordList._notifyValue: snap_keys=%s', util.keys(this.snaps));
      var factory = new SnapshotFactory('value', null, util.toArray(this.snaps));
      this.obs.trigger(factory);
    }
  },

  _getPrevChild: function(key) {
    if( !this.recIds.length ) { return null; }
    var pos = this.findKey(key);
    if( pos === -1 ) {
      return this.recIds[this.recIds.length-1];
    }
    else if( pos === 0 ) {
      return null;
    }
    else {
      return this.recIds[pos-1];
    }
  },

  _posFor: function(prevKey) {
    var pos, x;
    if( prevKey === null ) {
      pos = 0;
    }
    else {
      x = this.findKey(prevKey);
      pos = x === -1? this.recIds.length : x+1;
    }
    return pos;
  },

  _putAfter: function(key, prevChild) {
    var newPos = this._posFor(prevChild);
    this.recIds.splice(newPos, 0, key);
  },

  _dropRecord: function(key) {
    var res = null;
    if(this.recs[key]) {
      res = this.snaps[key];
      this.recs[key].unwatch();
    }
    if(this.loading[key]) {
      this.loading[key].unwatch();
    }
    if(util.has(this.filtered, key)) {
      this.filtered[key].unwatch();
    }
    delete this.loading[key];
    delete this.snaps[key];
    delete this.filtered[key];
    delete this.recs[key];
    util.remove(this.recIds, key);
    return res;
  },

  /**
   * Because the initial once('value') will probably trigger before all the child paths
   * are retrieved (remember that we are monitoring multiple paths per child), we need
   * to wait for them to load in before triggering our first value event.
   * @private
   */
  _checkLoadState: function(key) {
    if( !this.loadComplete ) {
      if( key ) {
        util.remove(this.initialKeysLeft, key);
      }
      if( !this.initialKeysLeft.length && this.masterLoaded ) {
        this.loadComplete = true;
        return true;
      }
    }
    return false;
  }
};

module.exports = RecordSetEventManager;