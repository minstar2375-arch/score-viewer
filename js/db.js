// 악보와 필기를 이 기기의 브라우저(IndexedDB)에 저장합니다.
//   scores: 목록에 필요한 정보 (제목, 쪽수, 마지막으로 본 쪽, 썸네일)
//   files:  PDF 원본
//   notes:  쪽별 필기 (key = "악보ID:쪽번호")

const DB_NAME = 'score-viewer';
const DB_VERSION = 1;
let dbPromise;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('scores', { keyPath: 'id' });
      db.createObjectStore('files', { keyPath: 'id' });
      db.createObjectStore('notes', { keyPath: 'key' }).createIndex('scoreId', 'scoreId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// fn이 돌려준 요청의 결과를, 트랜잭션이 끝까지 성공한 뒤에 돌려줍니다.
async function run(stores, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const req = fn(tx);
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const listScores = () =>
  run('scores', 'readonly', (tx) => tx.objectStore('scores').getAll());

export const getScore = (id) =>
  run('scores', 'readonly', (tx) => tx.objectStore('scores').get(id));

export const putScore = (score) =>
  run('scores', 'readwrite', (tx) => tx.objectStore('scores').put(score));

export const addScore = (score, data) =>
  run(['scores', 'files'], 'readwrite', (tx) => {
    tx.objectStore('scores').put(score);
    tx.objectStore('files').put({ id: score.id, data });
  });

export async function getFile(id) {
  const row = await run('files', 'readonly', (tx) => tx.objectStore('files').get(id));
  return row?.data;
}

export const deleteScore = (id) =>
  run(['scores', 'files', 'notes'], 'readwrite', (tx) => {
    tx.objectStore('scores').delete(id);
    tx.objectStore('files').delete(id);
    const notes = tx.objectStore('notes');
    notes.index('scoreId').getAllKeys(id).onsuccess = (e) => {
      for (const key of e.target.result) notes.delete(key);
    };
  });

export async function getNotes(scoreId, page) {
  const row = await run('notes', 'readonly', (tx) =>
    tx.objectStore('notes').get(`${scoreId}:${page}`));
  return row?.items ?? [];
}

export const saveNotes = (scoreId, page, items) =>
  run('notes', 'readwrite', (tx) => {
    const store = tx.objectStore('notes');
    const key = `${scoreId}:${page}`;
    return items.length ? store.put({ key, scoreId, page, items }) : store.delete(key);
  });
