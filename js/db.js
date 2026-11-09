// 악보와 필기를 이 기기의 브라우저(IndexedDB)에 저장합니다.
//   scores: 목록에 필요한 정보 (제목, 쪽수, 마지막으로 본 쪽, 썸네일)
//   files:  PDF 원본
//   notes:  쪽별 필기 (key = "악보ID:쪽번호")
//   recordings: 악보별 연습 녹음
//   tracks: 악보별 연습 음원 (파일 또는 YouTube 링크)

const DB_NAME = 'score-viewer';
const DB_VERSION = 3;
let dbPromise;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // 이미 저장된 악보와 필기가 지워지지 않도록, 없는 저장소만 새로 만듭니다.
    req.onupgradeneeded = () => {
      const db = req.result;
      const has = (name) => db.objectStoreNames.contains(name);
      if (!has('scores')) db.createObjectStore('scores', { keyPath: 'id' });
      if (!has('files')) db.createObjectStore('files', { keyPath: 'id' });
      if (!has('notes')) {
        db.createObjectStore('notes', { keyPath: 'key' }).createIndex('scoreId', 'scoreId');
      }
      if (!has('recordings')) {
        db.createObjectStore('recordings', { keyPath: 'id' }).createIndex('scoreId', 'scoreId');
      }
      if (!has('tracks')) {
        db.createObjectStore('tracks', { keyPath: 'id' }).createIndex('scoreId', 'scoreId');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = undefined;
      };
      resolve(db);
    };
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
  run(['scores', 'files', 'notes', 'recordings', 'tracks'], 'readwrite', (tx) => {
    tx.objectStore('scores').delete(id);
    tx.objectStore('files').delete(id);
    for (const name of ['notes', 'recordings', 'tracks']) {
      const store = tx.objectStore(name);
      store.index('scoreId').getAllKeys(id).onsuccess = (e) => {
        for (const key of e.target.result) store.delete(key);
      };
    }
  });

export const listRecordings = (scoreId) =>
  run('recordings', 'readonly', (tx) => tx.objectStore('recordings').index('scoreId').getAll(scoreId));

export const addRecording = (recording) =>
  run('recordings', 'readwrite', (tx) => tx.objectStore('recordings').put(recording));

export const deleteRecording = (id) =>
  run('recordings', 'readwrite', (tx) => tx.objectStore('recordings').delete(id));

export const listTracks = (scoreId) =>
  run('tracks', 'readonly', (tx) => tx.objectStore('tracks').index('scoreId').getAll(scoreId));

export const putTrack = (track) =>
  run('tracks', 'readwrite', (tx) => tx.objectStore('tracks').put(track));

export const deleteTrack = (id) =>
  run('tracks', 'readwrite', (tx) => tx.objectStore('tracks').delete(id));

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
