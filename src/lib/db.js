import { MongoClient } from "mongodb";

let _client = null;
let _db = null;

export async function getDb(mongoUri) {
  if (!mongoUri) return null;
  if (_db) return _db;

  _client = new MongoClient(mongoUri, { maxPoolSize: 5 });
  await _client.connect();
  _db = _client.db(); // default DB from URI
  return _db;
}
