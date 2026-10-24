// lib/targets.js
// Which documents a script works on, from the same four CONFIG keys everywhere:
//
//   COLLECTION            a collection path ("users", "users/abc/posts"), or with
//                         USE_COLLECTION_GROUP a collection id ("posts")
//   USE_COLLECTION_GROUP  every collection with that id, at any depth
//   WHERE                 [[field, op, value], ...] filters
//   DOC_IDS               only these ids (not with USE_COLLECTION_GROUP)
//
// Documents are read a page at a time, so a large collection never sits in memory.

const PAGE_SIZE = 500;

function validateTarget(cfg) {
  if (!cfg.COLLECTION || typeof cfg.COLLECTION !== "string") throw new Error("CONFIG.COLLECTION must be a non-empty string.");
  const segments = cfg.COLLECTION.split("/");
  if (segments.some((s) => !s)) throw new Error(`CONFIG.COLLECTION "${cfg.COLLECTION}" has an empty segment.`);
  if (cfg.USE_COLLECTION_GROUP) {
    if (segments.length !== 1) throw new Error("With USE_COLLECTION_GROUP, CONFIG.COLLECTION is a collection id, not a path.");
  } else if (segments.length % 2 !== 1) {
    throw new Error(`CONFIG.COLLECTION "${cfg.COLLECTION}" is a document path, not a collection.`);
  }
  const where = cfg.WHERE || [];
  const docIds = cfg.DOC_IDS || [];
  if (!Array.isArray(where)) throw new Error("CONFIG.WHERE must be an array.");
  for (const clause of where) {
    if (!Array.isArray(clause) || clause.length !== 3) throw new Error(`Invalid WHERE clause: ${JSON.stringify(clause)}`);
  }
  if (!Array.isArray(docIds)) throw new Error("CONFIG.DOC_IDS must be an array.");
  if (cfg.USE_COLLECTION_GROUP && docIds.length) throw new Error("DOC_IDS is not supported with USE_COLLECTION_GROUP.");
  if (docIds.length && where.length) throw new Error("Use DOC_IDS or WHERE, not both.");
}

function describeTarget(cfg) {
  const where = (cfg.WHERE || []).map(([f, op, v]) => `${f} ${op} ${JSON.stringify(v)}`).join(" and ");
  const ids = cfg.DOC_IDS?.length ? ` (${cfg.DOC_IDS.length} ids)` : "";
  return `${cfg.USE_COLLECTION_GROUP ? "every '" + cfg.COLLECTION + "' collection" : `'${cfg.COLLECTION}'`}${where ? ` where ${where}` : ""}${ids}`;
}

function targetQuery(db, cfg) {
  let q = cfg.USE_COLLECTION_GROUP ? db.collectionGroup(cfg.COLLECTION) : db.collection(cfg.COLLECTION);
  for (const [field, op, value] of cfg.WHERE || []) q = q.where(field, op, value);
  return q;
}

/** Every matching document snapshot, a page at a time. */
async function* targetDocs(db, cfg, pageSize = PAGE_SIZE) {
  if (cfg.DOC_IDS?.length) {
    const col = db.collection(cfg.COLLECTION);
    for (let i = 0; i < cfg.DOC_IDS.length; i += pageSize) {
      const snaps = await db.getAll(...cfg.DOC_IDS.slice(i, i + pageSize).map((id) => col.doc(id)));
      for (const s of snaps) if (s.exists) yield s;
    }
    return;
  }
  const base = targetQuery(db, cfg);
  let last = null;
  for (;;) {
    const page = await (last ? base.startAfter(last) : base).limit(pageSize).get();
    for (const s of page.docs) yield s;
    if (page.size < pageSize) return;
    last = page.docs[page.docs.length - 1];
  }
}

module.exports = { validateTarget, describeTarget, targetQuery, targetDocs };
