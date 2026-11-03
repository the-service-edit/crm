// TSE CRM: Gmail sync endpoint.
// GET  -> the addresses and domains the CRM is watching (so Gmail only sends matching mail).
// POST -> {messages:[...]} logs new sent emails and replies against the right lead and moves the deal on.
//         Optional {scheduled:[{id,threadId,to,cc,subject,date}]}: the FULL current list of Gmail scheduled sends (in:scheduled).
//         Sets data.scheduledAt / scheduledSubject on each matching live opp and clears it on every other opp.
// Auth: header x-ingest-key, checked against a hash in crm_ingest_keys. Nothing is stored for mail that matches no lead.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const ME = "hello@theserviceedit.com";
const FREE = /(^|\.)(gmail|googlemail|hotmail|outlook|yahoo|icloud|me|live|bigpond|optusnet|iinet|aol|proton|protonmail)\./i;
const DEFAULT_STAGES: Record<string, string[]> = {
  email: ["Lead identified","Brand research","Mockup in progress","Creative assets","Mockup completed","Ready for outreach","Outreach sent","First follow-up","Second follow-up","Replied","Discovery call","Proposal sent","Negotiation","Won","Lost"],
  web: ["Lead identified","Research / audit","Mockup in progress","Mockup completed","Ready for outreach","Outreach sent","First follow-up","Second follow-up","Replied","Meeting booked","Proposal sent","Negotiation","Won","Lost"],
};
const RANK: Record<string, number> = { pre: 0, out: 1, replied: 2, meeting: 3, proposal: 4, negotiation: 5, won: 6, lost: -1 };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

function role(name: string) {
  const n = (name || "").toLowerCase();
  if (/\bwon\b/.test(n)) return "won";
  if (/lost|not proceeding/.test(n)) return "lost";
  if (/negotiat/.test(n)) return "negotiation";
  if (/proposal/.test(n)) return "proposal";
  if (/meeting|discovery|call booked/.test(n)) return "meeting";
  if (/repl|interested/.test(n)) return "replied";
  if (/outreach sent|follow.?up|sent/.test(n)) return "out";
  return "pre";
}
const emails = (s: string) => ((s || "").match(/[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map((x) => x.toLowerCase());
const perthDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Perth" }).format(d);
const addDays = (day: string, n: number) => { const d = new Date(day + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
async function sha256(s: string) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""); }
// A failed write must never be silent: throwing makes the POST return 500, so the Apps Script
// keeps its "since" marker and sends the same mail again next run (dedupe stops doubles).
const must = <T extends { error: unknown }>(r: T): T => { if (r.error) throw new Error(JSON.stringify(r.error)); return r; };
const rid = (p: string) => p + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function loadWatch() {
  const { data: cos } = await sb.from("crm_companies").select("id,data");
  const addr = new Map<string, string>(), dom = new Map<string, string>();
  for (const c of cos || []) {
    const d = c.data || {};
    const list = [d.email, ...String(d.altEmails || "").split(/[,\s]+/)].flatMap((x: string) => emails(x));
    for (const e of list) { addr.set(e, c.id); const dm = e.split("@")[1]; if (dm && !FREE.test(dm + ".") && dm !== "theserviceedit.com") dom.set(dm, c.id); }
    const w = String(d.website || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    if (w && w.includes(".") && !FREE.test(w + ".")) dom.set(w, c.id);
  }
  return { addr, dom };
}

Deno.serve(async (req) => {
  const key = req.headers.get("x-ingest-key") || "";
  if (key.length < 20) return json({ error: "unauthorised" }, 401);
  const { data: ok } = await sb.from("crm_ingest_keys").select("hash").eq("hash", await sha256(key)).maybeSingle();
  if (!ok) return json({ error: "unauthorised" }, 401);

  const { addr, dom } = await loadWatch();
  if (req.method === "GET") {
    const { data: g } = await sb.from("crm_settings").select("data").eq("id", "gmail").maybeSingle();
    await sb.from("crm_settings").upsert({ id: "gmail", data: { ...(g?.data || {}), lastRun: new Date().toISOString(), source: "apps-script" }, updated_at: new Date().toISOString() });
    return json({ addresses: [...addr.keys()], domains: [...dom.keys()] });
  }
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const body = await req.json().catch(() => ({}));
  const msgs: any[] = Array.isArray(body.messages) ? body.messages.slice(0, 50) : [];
  const { data: setRows } = await sb.from("crm_settings").select("id,data").in("id", ["main", "gmail"]);
  const settings = (setRows || []).find((r) => r.id === "main")?.data || {};
  const prevGmail = (setRows || []).find((r) => r.id === "gmail")?.data || {};
  const stagesOf = (p: string) => (settings.stages && settings.stages[p]?.length ? settings.stages[p] : DEFAULT_STAGES[p]);
  const nudge = Number(settings.nudgeDays) || 6, call = Number(settings.callDays) || 11;
  const today = perthDay(new Date());

  const match = (list: string[]) => { for (const e of list) { if (addr.has(e)) return addr.get(e)!; const dm = e.split("@")[1]; if (dom.has(dm)) return dom.get(dm)!; } return null; };
  let sent = 0, replies = 0, matchedDrafts = 0, skipped = 0;
  const touched: string[] = [];

  try {
  for (const m of msgs.sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    if (!m || !m.id) continue;
    const out = m.direction === "out" || emails(m.from).includes(ME);
    const cid = out ? match([...emails(m.to), ...emails(m.cc)]) : match(emails(m.from));
    if (!cid) { skipped++; continue; }
    const { data: dup } = await sb.from("crm_acts").select("id").eq("company_id", cid).or(`id.eq.gm-${m.id},data->>gmailMessageId.eq.${m.id}`).limit(1);
    if (dup && dup.length) continue;
    const at = new Date(m.date || Date.now()).toISOString();
    const text = String(m.body || "").replace(/\r/g, "").trim().slice(0, 12000);
    const { data: acts } = await sb.from("crm_acts").select("id,data").eq("company_id", cid);
    const { data: opps } = await sb.from("crm_opps").select("id,data").eq("company_id", cid);
    const live = (opps || []).filter((o) => !["won", "lost"].includes(role(o.data.stage)));
    const day = perthDay(new Date(at));

    if (out) {
      const subj = String(m.subject || "").trim().toLowerCase();
      const draft = (acts || []).find((a) => a.data.type === "email" && a.data.status === "draft" && String(a.data.subject || "").trim().toLowerCase() === subj);
      if (draft) {
        must(await sb.from("crm_acts").update({ data: { ...draft.data, status: "sent", at, body: text || draft.data.body, gmailMessageId: m.id, gmailThreadId: m.threadId || "", source: "gmail" }, updated_at: new Date().toISOString() }).eq("id", draft.id));
        matchedDrafts++;
      } else {
        must(await sb.from("crm_acts").insert({ id: "gm-" + m.id, company_id: cid, data: { companyId: cid, type: "email", direction: "out", status: "sent", subject: m.subject || "", body: text, to: m.to || "", at, gmailMessageId: m.id, gmailThreadId: m.threadId || "", source: "gmail", createdAt: new Date().toISOString() } }));
        sent++;
      }
      const nSent = (acts || []).filter((a) => a.data.type === "email" && a.data.status === "sent").length + 1;
      for (const o of live) {
        const d = { ...o.data }; const r = role(d.stage); const st = stagesOf(d.pipeline);
        let to = "";
        if (r === "pre") to = st.find((s: string) => role(s) === "out") || "";
        else if (r === "out" && nSent > 1) { const nx = st[st.indexOf(d.stage) + 1]; if (nx && role(nx) === "out") to = nx; }
        if (to && to !== d.stage) {
          must(await sb.from("crm_acts").insert({ id: rid("a"), company_id: cid, data: { companyId: cid, oppId: o.id, type: "stage", subject: d.stage + " → " + to, body: "Email sent (from Gmail)", at, createdAt: new Date().toISOString() } }));
          d.stage = to; d.stageChangedAt = at; d.maxRank = Math.max(d.maxRank || 0, RANK[role(to)] || 0);
        }
        delete d.scheduledAt; delete d.scheduledSubject;
        if (r === "pre" || r === "out") d.nextFollowUp = addDays(day, r === "pre" || nSent <= 1 ? nudge : call - nudge);
        d.lastContact = at; d.updatedAt = new Date().toISOString();
        await sb.from("crm_opps").update({ data: d, updated_at: new Date().toISOString() }).eq("id", o.id);
      }
    } else {
      const subj = String(m.subject || "");
      const personal = /^\s*(re|fw|fwd)\s*:/i.test(subj) && !m.bulk;
      const marketing = !personal && (!!m.bulk || /confirm (your )?subscription|welcome to|thanks for (subscribing|signing up|joining)|you're (in|subscribed)|order (confirmation|#)|your order|receipt|newsletter|verify your email/i.test(subj)
        || /unsubscribe|kmail-lists\.com|list-manage\.com|manage (your )?preferences|view (this|in) (email )?(in )?(your )?browser/i.test(text.slice(-3000) + " " + text.slice(0, 800))
        || /no-?reply|newsletter|mailer|notifications?@/i.test(String(m.from || "")));
      const auto = !!m.auto || /automatic reply|auto(-| )?reply|^auto:|out of office|thanks for getting in touch|we('ve| have) received your (email|message|enquiry)/i.test(subj)
        || /^\s*(thanks|thank you) for (getting in touch|your (email|message|enquiry))[\s\S]{0,200}(get back to you|respond) within/i.test(text);
      const firstOut = (acts || []).filter((a) => a.data.type === "email" && a.data.status === "sent" && a.data.direction !== "in").map((a) => { const t = new Date(a.data.at || ""); return isNaN(+t) ? "" : t.toISOString(); }).filter(Boolean).sort()[0];
      const afterOutreach = !!firstOut && firstOut <= at;
      const isReply = !marketing && afterOutreach;
      must(await sb.from("crm_acts").insert({ id: "gm-" + m.id, company_id: cid, data: { companyId: cid, type: isReply ? "reply" : "list", direction: "in", subject: subj, body: text, from: m.from || "", at, outcome: marketing ? "their marketing email" : !afterOutreach ? "email from them before outreach" : auto ? "auto-reply" : "", gmailMessageId: m.id, gmailThreadId: m.threadId || "", source: "gmail", createdAt: new Date().toISOString() } }));
      if (isReply && !auto) replies++;
      if (isReply && !auto) for (const o of live) {
        const d = { ...o.data }; const r = role(d.stage);
        if (r === "pre" || r === "out") {
          const to = stagesOf(d.pipeline).find((s: string) => role(s) === "replied");
          if (to) { must(await sb.from("crm_acts").insert({ id: rid("a"), company_id: cid, data: { companyId: cid, oppId: o.id, type: "stage", subject: d.stage + " → " + to, body: "Reply received (from Gmail)", at, createdAt: new Date().toISOString() } })); d.stage = to; d.stageChangedAt = at; d.maxRank = Math.max(d.maxRank || 0, 2); }
        }
        d.nextFollowUp = today; d.lastContact = at; d.updatedAt = new Date().toISOString();
        await sb.from("crm_opps").update({ data: d, updated_at: new Date().toISOString() }).eq("id", o.id);
      }
    }
    touched.push(cid);
  }

  } catch (e) {
    console.error("crm-gmail write failed, run will be retried", String(e));
    await sb.from("crm_settings").upsert({ id: "gmail", data: { ...prevGmail, lastRun: new Date().toISOString(), summary: "Sync error, retrying: " + String(e).slice(0, 120), source: "apps-script" }, updated_at: new Date().toISOString() });
    return json({ error: "write_failed", detail: String(e).slice(0, 300) }, 500);
  }

  // Scheduled sends: only when the caller sends the list (an absent list leaves everything as it is).
  let scheduled = 0;
  if (Array.isArray(body.scheduled)) {
    const due = new Map<string, { at: string; subject: string }>();
    for (const m of body.scheduled.slice(0, 200)) {
      if (!m) continue;
      const cid = match([...emails(m.to), ...emails(m.cc)]); if (!cid) continue;
      const t = new Date(m.date || ""); if (isNaN(+t)) continue;
      const at = t.toISOString(); const cur = due.get(cid);
      if (!cur || at < cur.at) due.set(cid, { at, subject: String(m.subject || "") });
    }
    const { data: all } = await sb.from("crm_opps").select("id,company_id,data");
    for (const o of all || []) {
      const d = { ...o.data }; const want = ["won", "lost"].includes(role(d.stage)) ? undefined : due.get(o.company_id);
      if (want) { scheduled++; if (d.scheduledAt === want.at && d.scheduledSubject === want.subject) continue; d.scheduledAt = want.at; d.scheduledSubject = want.subject; }
      else { if (!d.scheduledAt && !d.scheduledSubject) continue; delete d.scheduledAt; delete d.scheduledSubject; }
      await sb.from("crm_opps").update({ data: d, updated_at: new Date().toISOString() }).eq("id", o.id);
    }
  }

  const parts = [];
  if (replies) parts.push(`${replies} repl${replies === 1 ? "y" : "ies"}`);
  if (sent + matchedDrafts) parts.push(`${sent + matchedDrafts} sent`);
  const summary = parts.length ? "Last sync logged " + parts.join(", ") : (prevGmail.summary || "Nothing new");
  await sb.from("crm_settings").upsert({ id: "gmail", data: { lastRun: new Date().toISOString(), summary, source: "apps-script" }, updated_at: new Date().toISOString() });
  return json({ ok: true, sent, matchedDrafts, replies, skipped, scheduled, leads: [...new Set(touched)].length });
});
