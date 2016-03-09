'use strict';

const _          = require('lodash');
const Lazy       = require('lazy.js');
const async      = require('asyncawait/async');
const await      = require('asyncawait/await');
const ipfsAPI    = require('orbit-common/lib/ipfs-api-promised');
const List       = require('./List');
const OrbitNode  = require('./OrbitNode');

const MaxBatchSize = 10;  // How many items per sequence. Saves a snapshot to ipfs in batches of this many items.
const MaxHistory   = 256; // How many items to fetch in the chain per join

// class IPFSLWWSet extends LWWSet {
class OrbitList extends List {
  constructor(ipfs, id, seq, ver, items) {
    super(id, seq, ver, items);
    this._ipfs = ipfs;
  }

  add(data) {
    if(this.ver >= MaxBatchSize)
      this._commit();

    const heads = List.findHeads(this.items);
    const node  = new OrbitNode(this._ipfs, this.id, this.seq, this.ver, data, heads);
    this._currentBatch.push(node);
    this.ver ++;
  }

  join(other) {
    super.join(other);
    const history = _.flatten(await(this._fetchHistory(other.items)));
    history.forEach((f) => this._insert(f)) // Insert to the list
  }

  /* Private methods */
  _fetchHistory(items) {
    var _fetchAsync = async(() => {
      return new Promise(async((resolve, reject) => {
        let allHashes = this._items.map((a) => a.hash);
        const handle = Lazy(items)
          .reverse() // Start from the latest item
          .map((f) => f.heads).flatten() // Go through all heads
          .filter((f) => !(f instanceof OrbitNode === true)) // OrbitNode vs. {}, filter out instances (we already have them in mem)
          .async() // Do the next map asynchronously
          .map(async((f) => _.flatten(await(this._fetchRecursive(f, allHashes, MaxHistory, 0))))) // IO - fetch items recursively
          .take(MaxHistory) // How many items from the history we should fetch
          .toArray();
        // console.log("--> Fetched", res.length, "items from the history");

        handle.onComplete(resolve);
      }));
    })
    return await(_fetchAsync());
  }

  // Fetch items in the linked list recursively
  _fetchRecursive(hash, all, amount, depth) {
    var _fetchAsync = async(() => {
      return new Promise(async((resolve, reject) => {
        const isReferenced = (list, item) => Lazy(list).reverse().find((f) => f === item) !== undefined;
        let result = [];

        if(depth >= amount) {
          resolve(result)
          return;
        }

        if(!isReferenced(all, hash)) {
          const item = await(OrbitNode.fromIpfsHash(this._ipfs, hash)); // IO - get from IPFS
          result.push(item);
          all.push(hash);
          depth ++;

          const handle = Lazy(item.heads)
            .async()
            .map(async((f) => _.flatten(await(this._fetchRecursive(f, all, amount, depth)))))
            .toArray()

          handle.onComplete((res) => {
            result = result.concat(res);
            resolve(result);
          });
        } else {
          resolve(result)
        }
      }));
    })
    return await(_fetchAsync());
  }

  // Insert to the list right after the latest parent
  _insert(item) {
    let indices = Lazy(item.heads).map((next) => Lazy(this._items).map((f) => f.hash).indexOf(next)) // Find the item's parent's indices
    const index = indices.length > 0 ? Math.max(indices.max() + 1, 0) : 0; // find the largest index (latest parent)
    this._items.splice(index, 0, item);
    return item;
  }

  /* Properties */
  get ipfsHash() {
    const toIpfs = async(() => {
      return new Promise(async((resolve, reject) => {
        var data = await(this.asJson)
        const list = await(ipfsAPI.putObject(this._ipfs, JSON.stringify(data)));
        resolve(list.Hash);
      }));
    });
    this.hash = await(toIpfs());
    return this.hash;
  }

  get asJson() {
    let items = {};
    this._currentBatch.forEach((f) => {
      if(!items[f.compactId.toString()])
        Object.defineProperty(items, f.compactId.toString(), { value: await(f.ipfsHash), enumerable: true });
    });
    return {
      id: this.id,
      seq: this.seq,
      ver: this.ver,
      items: items
    }
  }

  static fromIpfsHash(ipfs, hash) {
    const fromIpfs = async(() => {
      return new Promise(async((resolve, reject) => {
        const l = await(ipfsAPI.getObject(ipfs, hash));
        const list = OrbitList.fromJson(ipfs, JSON.parse(l.Data));
        resolve(list);
      }));
    });
    return await(fromIpfs());
  }

  static fromJson(ipfs, json) {
    const items = Object.keys(json.items).map((f) => await(OrbitNode.fromIpfsHash(ipfs, json.items[f])));
    return new OrbitList(ipfs, json.id, json.seq, json.ver, items);
  }

  static get batchSize() {
    return MaxBatchSize;
  }

  static get maxHistory() {
    return MaxHistory;
  }
}

module.exports = OrbitList;
