import { Store } from '../apps/server/src/store.ts';
import { seedDemo } from '../apps/server/src/seed.ts';
const store = new Store(process.env.DATABASE_PATH ?? 'data/signaldesk.sqlite');
store.transaction(() => {
  store.db.prepare("DELETE FROM telemetry WHERE workspace='demo'").run();
  store.db.prepare("DELETE FROM entities WHERE workspace='demo'").run();
  store.db.prepare("DELETE FROM audit WHERE workspace='demo'").run();
  store.db.prepare("DELETE FROM settings WHERE key='demoNow'").run();
});
seedDemo(store);
store.close();
console.log('Demo fixtures reset. Live data was preserved.');
