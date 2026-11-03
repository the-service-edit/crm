// Keeps the app shell available; data always comes live from the database.
const C='tse-crm-v22';
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>c.addAll(['./','index.html','manifest.webmanifest','icon-192.png'])));});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url); if(e.request.method!=='GET'||u.origin!==location.origin) return;
  e.respondWith(fetch(e.request,{cache:'no-store'}).then(r=>{const cp=r.clone(); caches.open(C).then(c=>c.put(e.request,cp)); return r;}).catch(()=>caches.match(e.request)));});

// Push notifications from the crm-push edge function: {title, body, url ("#open=<companyId>"), tag}.
self.addEventListener('push',e=>{
  let d={}; try{ d=e.data?e.data.json():{}; }catch(_){ d={title:'TSE CRM',body:e.data?e.data.text():''}; }
  e.waitUntil(self.registration.showNotification(d.title||'TSE CRM',{body:d.body||'',tag:d.tag||undefined,renotify:!!d.tag,icon:'icon-192.png',badge:'icon-192.png',data:{url:d.url||'#today'}}));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  const hash=(e.notification.data&&e.notification.data.url)||'#today';
  const m=hash.match(/^#open=([\w-]+)/);
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{
    const w=cs.find(c=>c.url.startsWith(self.registration.scope));
    if(w){ if(m) w.postMessage({open:m[1]}); return w.focus(); }
    return self.clients.openWindow(self.registration.scope+hash);
  }));
});
