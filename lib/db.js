/* ============================================================
   DATA LAYER — see lib/store.js
   ============================================================

   The database is SQLite (data/volyx.db). This module is the stable
   façade the rest of the server imports:

     db()          the shared in-memory object graph
     persist()     flush only what changed, in one transaction
     resetDb()     wipe and start over
     blank()       an empty database in the same shape
     uid()         id generator

   Plus the things the upgrade made possible:

     audit() / readAudit()      append-only history of privileged actions
     sessionsFor(userId)        where an account is signed in
     pruneExpired()             housekeeping for sessions + codes
     stats() / integrity()      health detail
     backupNow() / closeStore() daily snapshot, clean shutdown
   ============================================================ */

export {
  SCHEMA,
  db,
  persist,
  resetDb,
  blank,
  uid,
  dbPath,
  audit,
  readAudit,
  auditActions,
  sessionsFor,
  pruneExpired,
  stats,
  integrity,
  backupNow,
  vacuum,
  closeStore,
} from './store.js';
