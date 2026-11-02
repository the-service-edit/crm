/**
 * TSE CRM: tell the CRM what is sitting in Gmail's Scheduled folder.
 * Paste this at the bottom of TSE-CRM-Gmail-Sync.gs, then add ONE line as the
 * last line inside syncCrm(), using the same URL and key your script already uses:
 *
 *   postScheduledToCrm(<your crm-gmail URL>, <your ingest key>);
 *
 * It sends the FULL current list each run, so anything you unschedule or that has
 * gone out drops off the CRM's Scheduled column on the next 10-minute run.
 */
function postScheduledToCrm(url, key) {
  var now = new Date(), list = [];
  GmailApp.search('in:scheduled', 0, 200).forEach(function (t) {
    t.getMessages().forEach(function (m) {
      if (m.getDate() > now) list.push({
        id: m.getId(), threadId: t.getId(), to: m.getTo(), cc: m.getCc(),
        subject: m.getSubject(), date: m.getDate().toISOString()
      });
    });
  });
  UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-ingest-key': key },
    payload: JSON.stringify({ messages: [], scheduled: list })
  });
}
