// api/work-orders.js
//
// GET   -> list all work orders (protected by login)
// PATCH -> update ONE OR MORE work orders' status, e.g. Open -> Completed
//
// Accountability: whoever is logged in when a work order is marked
// Completed gets recorded automatically as "Closed By" — pulled from
// the real session, never something typed into a form. This can't be
// faked or left blank.
//
// Supports closing multiple work orders in a single request — the
// frontend can select several and close them all at once without a
// page reload between each one.

import { getSession, setSessionCookie } from "../lib/auth.js";
import { getChecklistForWorkOrder } from "../lib/checklists.js";
import { can } from "../lib/roles.js";
import { getAssignedRole } from "../lib/routing.js";
import { getAllStaffDirectory, getContactForUsername } from "../lib/staffDirectory.js";

// "Assigned Role" on a work order is a display label (Mechanical,
// Electrical, Admin, Property Manager, or External). Login roles are
// the actual permission-checked identities (mechanical_engineer,
// etc). This maps one to the other so closure sign-off can verify the
// specific person reviewing is actually who the job was routed to.
// Shared by closure review AND procurement approve/reject — Business
// Owner / System Admin can act on any work order; every other routed
// role must match the specific role this work order was actually
// assigned to. Returns null if allowed, or an error message if not.
async function checkRoutedRoleMatch(session, recordId) {
  if (session.r === "business_owner" || session.r === "system_admin") return null;
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");
  const checkResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  });
  if (!checkResp.ok) return null; // fail open ONLY on a read error — a network/API failure, not a routing gap
  const checkData = await checkResp.json();
  const assignedRole = checkData.fields["Assigned Role"];

  // External has no matching login role at all — there's nobody to
  // check permissions against except whoever actually arranged the
  // handoff, recorded at the moment it was assigned. Confirmed:
  // that person specifically, not "any Admin," gets to sign off.
  if (assignedRole === "External") {
    const handledBy = checkData.fields["Assigned Role Set By"];
    if (handledBy && session.u === handledBy) return null;
    return `Only ${handledBy || "whoever arranged the external handoff"} can act on this work order.`;
  }

  const expectedLoginRole = ASSIGNED_ROLE_TO_LOGIN_ROLE[assignedRole];
  // Fail CLOSED on anything unmapped (missing, unrecognized, or a
  // stray value) — an unrouted work order should never silently let
  // just anyone through. Previously this fell through to "allowed,"
  // which was a real gap.
  if (!expectedLoginRole) {
    return "This work order has no recognized routed role — it can't be acted on until it's assigned.";
  }
  if (session.r !== expectedLoginRole) {
    return `Only ${assignedRole} can act on this work order.`;
  }
  return null;
}

const ASSIGNED_ROLE_TO_LOGIN_ROLE = {
  "Mechanical": "mechanical_engineer",
  "Electrical": "electrical_engineer",
  "Admin": "admin",
  "Property Manager": "property_manager",
};

export default async function handler(req, res) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not logged in" });
  }
  setSessionCookie(res, session.u, session.r);

  // Merged endpoints: ?report=true for maintenance report, ?checklist=CLASS for checklists
  if (req.method === "GET" && req.query.report === "true") {
    return handleMaintenanceReport(req, res);
  }
  // checklist may be an empty string — that's the normal case when no
  // asset-class keyword matched client-side. The tiered resolver below
  // still returns something: assignedRole (work orders) or a
  // system/assetName-derived discipline (Asset Register, which has no
  // Assigned Role of its own) falls back to a generic discipline
  // checklist, and the universal fallback covers everything else. This
  // is what guarantees every work order and every asset shows SOME
  // checklist, never nothing.
  if (req.method === "GET" && req.query.checklist !== undefined) {
    let assignedRole = req.query.assignedRole || null;
    if (!assignedRole && req.query.system) {
      assignedRole = getAssignedRole(req.query.system, req.query.assetName || "") || null;
    }
    const result = getChecklistForWorkOrder(req.query.checklist || null, assignedRole);
    return res.status(200).json(result);
  }

  if (req.method === "GET") {
    try {
      const records = await fetchAllWorkOrders();
      const workOrders = records
        .map(r => ({
          id: r.id,
          woId: r.fields["WO ID"] || "",
          assetId: r.fields["Asset ID"] || "",
          assetName: r.fields["Asset Name"] || "",
          system: r.fields["System"] || "",
          location: r.fields["Location"] || "",
          status: r.fields["Status"] || "Open",
          urgency: r.fields["Urgency"] || "",
          maintenanceType: r.fields["Maintenance Type"] || "",
          created: r.fields["Created"] || "",
          completedDate: r.fields["Completed Date"] || "",
          closedBy: r.fields["Closed By"] || "",
          cost: r.fields["Cost (TZS)"] || null, costEditedBy: r.fields["Cost Edited By"] || "", costEditedDate: r.fields["Cost Edited Date"] || "", checklistProgress: r.fields["Checklist Progress"] || "{}", activityLog: r.fields["Activity Log"] || "[]", chatLog: r.fields["Chat Log"] || "[]", chatParticipants: r.fields["Chat Participants"] || "[]", chatReadReceipts: r.fields["Chat Read Receipts"] || "{}", assignedRole: r.fields["Assigned Role"] || "", assignedRoleSetBy: r.fields["Assigned Role Set By"] || "", assignedTechnician: r.fields["Assigned Technician"] || "", assignedTechnicianSetBy: r.fields["Assigned Technician Set By"] || "", assignmentStatus: r.fields["Assignment Status"] || "", externalAssigneeName: r.fields["External Assignee Name"] || "", externalAssigneeContact: r.fields["External Assignee Contact"] || "", procurementStatus: r.fields["Procurement Status"] || "None", costBreakdown: r.fields["Cost Breakdown"] || "[]", procurementRequestedBy: r.fields["Procurement Requested By"] || "", procurementApprovedBy: r.fields["Procurement Approved By"] || "", procurementRejectionReason: r.fields["Procurement Rejection Reason"] || "", beforePhoto: (r.fields["Before Photo"] || [])[0] ? r.fields["Before Photo"][0].url : null, afterPhoto: (r.fields["After Photo"] || [])[0] ? r.fields["After Photo"][0].url : null, reporterContact: r.fields["Reporter Contact"] || "", reporterPhoto: (r.fields["Reporter Photo"] || [])[0] ? r.fields["Reporter Photo"][0].url : null, satisfactionStatus: r.fields["Satisfaction Status"] || "", satisfactionReason: r.fields["Satisfaction Reason"] || "", closureRejectionReason: r.fields["Closure Rejection Reason"] || "",
          notes: r.fields["Notes"] || "",
        }))
        .sort((a, b) => new Date(b.created) - new Date(a.created));
      return res.status(200).json({ workOrders });
    } catch (err) {
      console.error("work-orders GET error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === "POST" && req.body && req.body.orderSparePart) {
    return handleOrderSparePart(req, res, session.u);
  }

  if (req.method === "POST") {
    return handleScheduleInspection(req, res, session.u);
  }

  if (req.method === "PUT" && req.body && req.body.action === "uploadWorkOrderPhoto") {
    return handleUploadWorkOrderPhoto(req, res, session.u);
  }

  if (req.method === "PATCH") {
    // Cost-only edit — for adding/correcting a cost on a work order that's
    // already Completed. Deliberately separate from the status-change path
    // below: it must NOT touch Closed By, Completed Date, or trigger the
    // Next-Service-Due rollover again, since those already happened when
    // the work order was first completed. Editing cost afterward should
    // never reassign who closed it.
    // Checklist item toggle — real, per-work-order accountability for
    // ISO checklist items. Never blocks closing the work order; it's a
    // status signal, not a gate, matching what was explicitly asked for.
    // Activity log — makes every work order a real, timestamped
    // conversation: comments, procurement requests, status notes, all
    // attributed to who actually wrote them and when. This is the
    // foundation the routing/approval/performance-tracking pieces will
    // build on next.
    // Procurement — a real blocking gate. Requesting it locks the work
    // order from being closed until an Engineer+ approves the cost
    // breakdown AND it's marked fulfilled. Rejection sends it back for
    // revision rather than a dead end.
    if (req.body && req.body.requestProcurement) {
      const { recordId, lineItems } = req.body;
      if (!recordId || !Array.isArray(lineItems) || lineItems.length === 0) {
        return res.status(400).json({ error: "recordId and at least one line item required" });
      }
      const total = lineItems.reduce((sum, item) => sum + (Number(item.cost) || 0), 0);
      try {
        const base = process.env.AIRTABLE_BASE_ID;
        const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");

        const currentResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
        });
        const current = currentResp.ok ? await currentResp.json() : { fields: {} };

        const patchResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            fields: {
              "Procurement Status": "Requested",
              "Cost Breakdown": JSON.stringify(lineItems),
              "Procurement Requested By": session.u,
              "Procurement Rejection Reason": "",
            },
          }),
        });
        if (!patchResp.ok) throw new Error("Could not save procurement request");
        await appendActivityLog(recordId, `🛒 Procurement requested — TZS ${total.toLocaleString()} (${lineItems.length} item${lineItems.length !== 1 ? "s" : ""})`, session.u, "procurement_request");
        await notifyEngineerOfProcurementRequest(recordId, current.fields["WO ID"] || "", current.fields["Asset Name"] || "Unnamed", current.fields["Assigned Role"], session.u, total);
        return res.status(200).json({ success: true, total });
      } catch (err) {
        console.error("requestProcurement error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    if (req.body && req.body.approveProcurement) {
      if (!can(session.r, "approveProcurement")) return res.status(403).json({ error: "Not permitted to approve procurement" });
      const { recordId } = req.body;
      if (!recordId) return res.status(400).json({ error: "recordId required" });
      const roleError = await checkRoutedRoleMatch(session, recordId);
      if (roleError) return res.status(403).json({ error: roleError });
      try {
        const base = process.env.AIRTABLE_BASE_ID;
        const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");

        const currentResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
        });
        const current = currentResp.ok ? await currentResp.json() : { fields: {} };
        let costBreakdown = [];
        try { costBreakdown = JSON.parse(current.fields["Cost Breakdown"] || "[]"); } catch { costBreakdown = []; }
        const total = costBreakdown.reduce((sum, item) => sum + (Number(item.cost) || 0), 0);

        const patchResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ fields: { "Procurement Status": "Approved", "Procurement Approved By": session.u } }),
        });
        if (!patchResp.ok) throw new Error("Could not approve procurement");
        await appendActivityLog(recordId, `✅ Procurement approved by ${session.u}`, session.u, "system");
        await notifyProcurementOfApproval(current.fields["WO ID"] || "", current.fields["Asset Name"] || "Unnamed", total, session.u);
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("approveProcurement error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    if (req.body && req.body.rejectProcurement) {
      if (!can(session.r, "approveProcurement")) return res.status(403).json({ error: "Not permitted to reject procurement" });
      const { recordId, reason } = req.body;
      if (!recordId || !reason) return res.status(400).json({ error: "recordId and reason required" });
      const roleError = await checkRoutedRoleMatch(session, recordId);
      if (roleError) return res.status(403).json({ error: roleError });
      try {
        const base = process.env.AIRTABLE_BASE_ID;
        const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");
        const patchResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ fields: { "Procurement Status": "Rejected", "Procurement Rejection Reason": reason } }),
        });
        if (!patchResp.ok) throw new Error("Could not reject procurement");
        await appendActivityLog(recordId, `❌ Procurement rejected by ${session.u} — ${reason}`, session.u, "system");
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("rejectProcurement error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    if (req.body && req.body.fulfillProcurement) {
      if (!can(session.r, "fulfillProcurement")) return res.status(403).json({ error: "Not permitted to fulfill procurement" });
      const { recordId } = req.body;
      if (!recordId) return res.status(400).json({ error: "recordId required" });
      try {
        const base = process.env.AIRTABLE_BASE_ID;
        const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");

        const currentResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
        });
        const current = currentResp.ok ? await currentResp.json() : { fields: {} };
        let costBreakdown = [];
        try { costBreakdown = JSON.parse(current.fields["Cost Breakdown"] || "[]"); } catch { costBreakdown = []; }
        const total = costBreakdown.reduce((sum, item) => sum + (Number(item.cost) || 0), 0);

        // Cost is recorded here, the moment procurement is actually
        // fulfilled — not left blank until someone closes the work
        // order later.
        const patchResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ fields: { "Procurement Status": "Fulfilled", "Cost (TZS)": total, "Cost Edited By": session.u, "Cost Edited Date": new Date().toISOString() } }),
        });
        if (!patchResp.ok) throw new Error("Could not mark procurement fulfilled");
        await appendActivityLog(recordId, `📦 Payment processed by ${session.u} — TZS ${total.toLocaleString()} recorded, routed role notified`, session.u, "system");
        await notifyRoutedRoleOfFulfillment(current.fields["Assigned Role"], current.fields["Asset Name"] || "Unnamed", current.fields["WO ID"] || "", total);

        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("fulfillProcurement error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Closure sign-off — only the SPECIFIC routed role a work order was
    // actually assigned to can approve or reject its finished work
    // (plus Business Owner / System Admin as a standing override).
    // This is the accountability piece: closing was never meant to be
    // just anyone with reviewWorkOrderClosure permission — it's whoever
    // actually owns that job.
    if (req.body && (req.body.approveClosure || req.body.rejectClosure)) {
      const { recordId } = req.body;
      if (!recordId) return res.status(400).json({ error: "recordId required" });

      if (!can(session.r, "reviewWorkOrderClosure")) {
        return res.status(403).json({ error: "Not permitted to review work order closure" });
      }

      // Business Owner / System Admin can act on any work order. Every
      // other routed role must match the specific role this work order
      // was actually assigned to.
      const roleError = await checkRoutedRoleMatch(session, recordId);
      if (roleError) return res.status(403).json({ error: roleError });

      if (req.body.approveClosure) return handleApproveClosure(req, res, session.u);
      return handleRejectClosure(req, res, session.u);
    }

    if (req.body && req.body.addActivityEntry) {
      const { recordId, text, entryType } = req.body;
      if (!recordId || !text) return res.status(400).json({ error: "recordId and text required" });

      try {
        const base = process.env.AIRTABLE_BASE_ID;
        const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");

        const getResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
        });
        if (!getResp.ok) throw new Error("Could not read work order");
        const woData = await getResp.json();

        let log = [];
        try { log = JSON.parse(woData.fields["Activity Log"] || "[]"); } catch { log = []; }

        log.push({
          type: entryType || "comment", // comment / procurement_request / system
          text,
          by: session.u,
          at: new Date().toISOString(),
        });

        const patchResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ fields: { "Activity Log": JSON.stringify(log) } }),
        });
        if (!patchResp.ok) throw new Error("Could not save activity entry");

        return res.status(200).json({ success: true, log });
      } catch (err) {
        console.error("activity log error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Work Order Chat — deliberately separate from Activity Log above.
    // Activity Log is the system's own timestamped record of what
    // changed (status moves, checklist ticks, procurement events).
    // Chat is people talking to each other about this specific job.
    // Open to anyone logged in who can see the work order — same as a
    // shared channel, not a members-only room. What's actually personal
    // is whether YOU'VE read it, tracked separately below.
    if (req.body && req.body.addChatMessage) {
      const { recordId, text } = req.body;
      if (!recordId || !text) return res.status(400).json({ error: "recordId and text required" });

      try {
        const base = process.env.AIRTABLE_BASE_ID;
        const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");

        const getResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
        });
        if (!getResp.ok) throw new Error("Could not read work order");
        const woData = await getResp.json();

        let chatLog = [];
        try { chatLog = JSON.parse(woData.fields["Chat Log"] || "[]"); } catch { chatLog = []; }
        chatLog.push({ text, by: session.u, at: new Date().toISOString() });

        // Sending a message means you've obviously seen everything up
        // to that point — stamp your own read receipt in the same
        // write, so you never see your own message as "unread."
        let readReceipts = {};
        try { readReceipts = JSON.parse(woData.fields["Chat Read Receipts"] || "{}"); } catch { readReceipts = {}; }
        readReceipts[session.u] = new Date().toISOString();

        const patchResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ fields: { "Chat Log": JSON.stringify(chatLog), "Chat Read Receipts": JSON.stringify(readReceipts) } }),
        });
        if (!patchResp.ok) throw new Error("Could not save chat message");

        return res.status(200).json({ success: true, chatLog, chatReadReceipts: readReceipts });
      } catch (err) {
        console.error("addChatMessage error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Marks a work order's chat as read for whoever is looking at it
    // right now — called the moment the chat panel actually renders
    // messages on screen, not on a timer or a guess. No participant
    // gate here: recording "I looked at this" is harmless even for an
    // overseer who never formally joined.
    if (req.body && req.body.markChatRead) {
      const { recordId } = req.body;
      if (!recordId) return res.status(400).json({ error: "recordId required" });

      try {
        const base = process.env.AIRTABLE_BASE_ID;
        const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");

        const getResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
        });
        if (!getResp.ok) throw new Error("Could not read work order");
        const woData = await getResp.json();

        let readReceipts = {};
        try { readReceipts = JSON.parse(woData.fields["Chat Read Receipts"] || "{}"); } catch { readReceipts = {}; }
        readReceipts[session.u] = new Date().toISOString();

        const patchResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ fields: { "Chat Read Receipts": JSON.stringify(readReceipts) } }),
        });
        if (!patchResp.ok) throw new Error("Could not save read receipt");

        return res.status(200).json({ success: true, chatReadReceipts: readReceipts });
      } catch (err) {
        console.error("markChatRead error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Reassigning a work order's routed role — this control didn't
    // exist before: Assigned Role was only ever set once, automatically,
    // at creation. Confirmed use cases: Admin correcting a "Not sure"
    // report that landed on the wrong discipline, an engineer handing
    // off a job that isn't actually theirs, or routing out to an
    // external maintenance company entirely. Just an edit to the field
    // — no separate reassignment history table.
    //
    // Permission: Business Owner / System Admin / Admin always; beyond
    // that, only whoever CURRENTLY holds the routed role can hand their
    // own job to someone else — a technician or an unrelated engineer
    // can't reroute a job that was never theirs.
    if (req.body && req.body.reassignWorkOrder) {
      const { recordId, assignedRole, externalName, externalContact } = req.body;
      const VALID_ROLES = ["Mechanical", "Electrical", "Admin", "Property Manager", "External"];
      if (!recordId || !assignedRole || !VALID_ROLES.includes(assignedRole)) {
        return res.status(400).json({ error: "recordId and a valid assignedRole are required" });
      }
      if (assignedRole === "External" && !externalName) {
        return res.status(400).json({ error: "External assignee name is required" });
      }

      try {
        const base = process.env.AIRTABLE_BASE_ID;
        const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");

        const getResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
        });
        if (!getResp.ok) throw new Error("Could not read work order");
        const woData = await getResp.json();
        const currentAssignedRole = woData.fields["Assigned Role"] || "";

        const isOverseer = session.r === "business_owner" || session.r === "system_admin";
        const currentLoginRole = ASSIGNED_ROLE_TO_LOGIN_ROLE[currentAssignedRole];
        const isCurrentHolder = !!currentLoginRole && session.r === currentLoginRole;
        const canReassign = isOverseer || session.r === "admin" || isCurrentHolder;

        if (!canReassign) {
          return res.status(403).json({ error: "Not permitted to reassign this work order." });
        }

        const fields = {
          "Assigned Role": assignedRole,
          "Assigned Role Set By": session.u,
        };
        if (assignedRole === "External") {
          fields["External Assignee Name"] = externalName;
          fields["External Assignee Contact"] = externalContact || "";
        } else {
          // Clear stale external contact info when routing back internally.
          fields["External Assignee Name"] = "";
          fields["External Assignee Contact"] = "";
        }

        const patchResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ fields }),
        });
        if (!patchResp.ok) throw new Error("Could not save reassignment");

        const label = assignedRole === "External" ? `External — ${externalName}` : assignedRole;
        await appendActivityLog(recordId, `🔀 Reassigned from ${currentAssignedRole || "Unassigned"} to ${label}`, session.u, "system");

        return res.status(200).json({ success: true, assignedRole, externalAssigneeName: fields["External Assignee Name"], externalAssigneeContact: fields["External Assignee Contact"] });
      } catch (err) {
        console.error("reassignWorkOrder error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Assigning a specific technician to a work order — a second,
    // separate layer beneath Assigned Role (the discipline). Any of
    // the four core roles can do this on any work order, regardless of
    // which discipline it's actually routed to (confirmed — this is
    // deliberately broader than the discipline-reassignment
    // permission). Setting this always puts the assignment in
    // "Pending" status — the technician still has to confirm before
    // it's real, see confirmAssignment/declineAssignment below.
    if (req.body && req.body.assignTechnician) {
      const { recordId, technicianUsername } = req.body;
      const CORE_ROLES = ["electrical_engineer", "mechanical_engineer", "admin", "property_manager"];
      const isOverseer = session.r === "business_owner" || session.r === "system_admin";
      if (!isOverseer && !CORE_ROLES.includes(session.r)) {
        return res.status(403).json({ error: "Only Electrical Engineer, Mechanical Engineer, Admin, or Property Manager can assign a technician." });
      }
      if (!recordId || !technicianUsername) {
        return res.status(400).json({ error: "recordId and technicianUsername required" });
      }

      const technicianContact = getContactForUsername(technicianUsername);
      if (!technicianContact || technicianContact.role !== "technician") {
        return res.status(400).json({ error: `"${technicianUsername}" is not a configured technician.` });
      }

      try {
        const base = process.env.AIRTABLE_BASE_ID;
        const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");

        const getResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
        });
        if (!getResp.ok) throw new Error("Could not read work order");
        const woData = await getResp.json();

        const patchResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ fields: {
            "Assigned Technician": technicianUsername,
            "Assigned Technician Set By": session.u,
            "Assignment Status": "Pending",
          } }),
        });
        if (!patchResp.ok) throw new Error("Could not save technician assignment");

        await appendActivityLog(recordId, `👷 Assigned to ${technicianUsername} by ${session.u}`, session.u, "system");

        const woId = woData.fields["WO ID"] || "";
        const assetName = woData.fields["Asset Name"] || "";
        await notifyTechnicianOfAssignment(technicianContact, woId, assetName);
        await notifyAssignerConfirmation(session.u, technicianUsername, woId, assetName);

        return res.status(200).json({ success: true, assignedTechnician: technicianUsername, assignmentStatus: "Pending" });
      } catch (err) {
        console.error("assignTechnician error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // The technician's own handshake — confirming they've actually
    // seen and accepted the job. Only the assigned technician
    // themselves can confirm (or decline) their own assignment.
    if (req.body && req.body.confirmAssignment) {
      const { recordId } = req.body;
      if (!recordId) return res.status(400).json({ error: "recordId required" });

      try {
        const base = process.env.AIRTABLE_BASE_ID;
        const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");

        const getResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
        });
        if (!getResp.ok) throw new Error("Could not read work order");
        const woData = await getResp.json();

        if (woData.fields["Assigned Technician"] !== session.u) {
          return res.status(403).json({ error: "This job isn't assigned to you." });
        }

        const patchResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ fields: { "Assignment Status": "Confirmed" } }),
        });
        if (!patchResp.ok) throw new Error("Could not confirm assignment");

        await appendActivityLog(recordId, `✅ Assignment confirmed by ${session.u}`, session.u, "system");

        return res.status(200).json({ success: true, assignmentStatus: "Confirmed" });
      } catch (err) {
        console.error("confirmAssignment error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Declining clears the assignment entirely (back to unassigned,
    // same as it was before anyone was picked) rather than leaving a
    // stale "Declined" state sitting on the work order — a reason is
    // required, and it's permanently recorded in the Activity Log, and
    // whoever made the original assignment is emailed so they know to
    // pick someone else. Confirmed: a reason is mandatory, not optional.
    if (req.body && req.body.declineAssignment) {
      const { recordId, reason } = req.body;
      if (!recordId || !reason || !reason.trim()) {
        return res.status(400).json({ error: "A reason is required to decline an assignment." });
      }

      try {
        const base = process.env.AIRTABLE_BASE_ID;
        const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");

        const getResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
        });
        if (!getResp.ok) throw new Error("Could not read work order");
        const woData = await getResp.json();

        if (woData.fields["Assigned Technician"] !== session.u) {
          return res.status(403).json({ error: "This job isn't assigned to you." });
        }
        const assignedBy = woData.fields["Assigned Technician Set By"] || "";

        const patchResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ fields: { "Assigned Technician": "", "Assignment Status": "" } }),
        });
        if (!patchResp.ok) throw new Error("Could not decline assignment");

        await appendActivityLog(recordId, `❌ Assignment declined by ${session.u}: ${reason.trim()}`, session.u, "system");

        const woId = woData.fields["WO ID"] || "";
        const assetName = woData.fields["Asset Name"] || "";
        if (assignedBy) {
          const assignerContact = getContactForUsername(assignedBy);
          if (assignerContact && assignerContact.email) {
            await notifyAssignerOfDecline(assignerContact.email, session.u, reason.trim(), woId, assetName);
          }
        }

        return res.status(200).json({ success: true, assignedTechnician: "", assignmentStatus: "" });
      } catch (err) {
        console.error("declineAssignment error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    if (req.body && req.body.checklistToggle) {
      const { recordId, itemId, checked } = req.body;
      if (!recordId || itemId === undefined || itemId === null) return res.status(400).json({ error: "recordId and itemId required" });

      try {
        const base = process.env.AIRTABLE_BASE_ID;
        const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");

        const getResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
        });
        if (!getResp.ok) throw new Error("Could not read work order");
        const woData = await getResp.json();

        let progress = {};
        try { progress = JSON.parse(woData.fields["Checklist Progress"] || "{}"); } catch { progress = {}; }

        // Unchecking used to just wipe the entry — no record of who
        // unchecked it or when. Every checklist action is now recorded
        // the same way, in both directions.
        progress[itemId] = { checked: !!checked, by: session.u, at: new Date().toISOString() };

        const patchResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ fields: { "Checklist Progress": JSON.stringify(progress) } }),
        });
        if (!patchResp.ok) throw new Error("Could not save checklist progress");

        const itemLabel = req.body.itemLabel || `item ${Number(itemId) + 1}`;
        const activityText = checked ? `☑ Checked off: ${itemLabel}` : `☐ Unchecked: ${itemLabel}`;
        const newEntry = await appendActivityLog(recordId, activityText, session.u, "system");

        return res.status(200).json({ success: true, progress, activityEntry: newEntry });
      } catch (err) {
        console.error("checklist toggle error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    if (req.body && req.body.costOnly) {
      const { recordId, cost } = req.body;
      if (!recordId) return res.status(400).json({ error: "recordId required" });
      if (!can(session.r, "enterWorkOrderCost")) {
        return res.status(403).json({ error: "Not permitted to edit work order costs." });
      }
      try {
        const base = process.env.AIRTABLE_BASE_ID;
        const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");
        const resp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            fields: {
              "Cost (TZS)": cost === "" || cost === undefined ? null : Number(cost),
              // Pulled from the verified session — same as Closed By,
              // Added By, etc. elsewhere in the system. Cannot be typed
              // in or faked by whoever's making the edit.
              "Cost Edited By": session.u,
              "Cost Edited Date": new Date().toISOString(),
            },
          }),
        });
        if (!resp.ok) throw new Error(await resp.text());
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("cost-only edit error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Accepts either a single { recordId, status } OR a bulk
    // { recordIds: [...], status } — same accountability rule either way.
    const { recordId, recordIds, status, notes, cost } = req.body || {};
    const ids = recordIds && Array.isArray(recordIds) ? recordIds : recordId ? [recordId] : [];

    if (ids.length === 0 || !status) {
      return res.status(400).json({ error: "recordId (or recordIds) and status required" });
    }

    // Cost is only ever applied if the session's role is actually
    // permitted to enter it — checked server-side, not just hidden in
    // the UI, so a Technician can't set it even by calling the API
    // directly. Technicians can still close work orders normally; they
    // just can't attach a cost figure to that closure.
    const canEnterCost = can(session.r, "enterWorkOrderCost");
    const effectiveCost = canEnterCost && cost !== undefined && cost !== "" ? cost : undefined;

    try {
      const results = await Promise.all(
        ids.map(id => updateWorkOrder(id, status, notes, session.u, effectiveCost))
      );
      const failed = results.filter(r => !r.ok);
      return res.status(200).json({
        success: failed.length === 0,
        updated: results.length - failed.length,
        failed: failed.length,
        errors: failed.map(f => f.error),
      });
    } catch (err) {
      console.error("work-orders PATCH error:", err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

// Shared helper — appends one entry to a work order's Activity Log,
// used by the procurement, checklist, closure, and photo-upload
// actions below. Read-modify-write, same pattern as the inline
// addActivityEntry handler.
async function appendActivityLog(recordId, text, by, type) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");

  const getResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  });
  if (!getResp.ok) { console.error("appendActivityLog: could not read work order"); return null; }
  const woData = await getResp.json();

  let log = [];
  try { log = JSON.parse(woData.fields["Activity Log"] || "[]"); } catch { log = []; }
  const entry = { type: type || "comment", text, by, at: new Date().toISOString() };
  log.push(entry);

  const patchResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { "Activity Log": JSON.stringify(log) } }),
  });
  if (!patchResp.ok) { console.error("appendActivityLog: could not save entry"); return null; }
  return entry;
}

// Before/after photo upload — same uploadAttachment pattern already
// used for Compliance Documents and Floor Plans elsewhere in this
// system. photoType is "before" or "after", mapping to the matching
// Airtable field.
async function handleUploadWorkOrderPhoto(req, res, uploadedBy) {
  const { recordId, photoType, filename, contentType, fileBase64 } = req.body || {};
  if (!recordId || !photoType || !filename || !fileBase64) {
    return res.status(400).json({ error: "recordId, photoType, filename, and fileBase64 are required" });
  }
  if (photoType !== "before" && photoType !== "after") {
    return res.status(400).json({ error: "photoType must be 'before' or 'after'" });
  }

  const fieldName = photoType === "before" ? "Before Photo" : "After Photo";

  try {
    const base = process.env.AIRTABLE_BASE_ID;
    const uploadResp = await fetch(
      `https://content.airtable.com/v0/${base}/${recordId}/${encodeURIComponent(fieldName)}/uploadAttachment`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ contentType: contentType || "image/jpeg", filename, file: fileBase64 }),
      }
    );
    if (!uploadResp.ok) throw new Error(await uploadResp.text());

    await appendActivityLog(recordId, `📷 ${photoType === "before" ? "Before" : "After"} photo uploaded by ${uploadedBy}`, uploadedBy, "system");

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("uploadWorkOrderPhoto error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function fetchAllWorkOrders() {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");
  let allRecords = [];
  let offset = null;

  do {
    const url = new URL(`https://api.airtable.com/v0/${base}/${table}`);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);

    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!resp.ok) throw new Error(`Airtable fetch failed: ${resp.status} ${await resp.text()}`);

    const data = await resp.json();
    allRecords = allRecords.concat(data.records || []);
    offset = data.offset;
  } while (offset);

  return allRecords;
}

async function updateWorkOrder(recordId, status, notes, closedByUsername, cost) {
  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");

  // Closing is never a single person's unilateral call anymore.
  // "Completed" can only be reached through the dedicated approveClosure
  // action below, which checks the routed role's sign-off. Anyone still
  // trying to set Status directly to Completed through this general
  // path is blocked here, server-side — the same principle as the
  // procurement gate: a real gate has to hold even if someone bypasses
  // the UI and calls the API directly.
  if (status === "Completed") {
    return {
      ok: false,
      recordId,
      error: "Work orders can no longer be closed directly. Mark it Ready for Review instead — the routed role approves the actual closure.",
    };
  }

  // A work order needs a routed role before it can ever reach Ready for
  // Review — confirmed requirement, no silent exceptions. Without a
  // routed role, there's nobody whose job it is to sign off on it.
  if (status === "Ready for Review") {
    const checkResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (checkResp.ok) {
      const checkData = await checkResp.json();
      if (!checkData.fields["Assigned Role"]) {
        return {
          ok: false,
          recordId,
          error: "This work order has no routed role assigned yet — it can't be marked Ready for Review until it does.",
        };
      }
      const procStatus = checkData.fields["Procurement Status"];
      if (procStatus === "Requested" || procStatus === "Rejected") {
        return {
          ok: false,
          recordId,
          error: procStatus === "Requested"
            ? "This work order can't be marked Ready for Review yet — procurement is still awaiting approval."
            : `This work order can't be marked Ready for Review yet — the procurement request was rejected (${checkData.fields["Procurement Rejection Reason"] || "no reason given"}) and needs to be revised.`,
        };
      }
    }
  }

  const fields = { "Status": status };
  if (notes !== undefined) fields["Notes"] = notes;
  if (cost !== undefined) {
    fields["Cost (TZS)"] = Number(cost);
    fields["Cost Edited By"] = closedByUsername;
    fields["Cost Edited Date"] = new Date().toISOString();
  }

  const resp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`Work order update failed for ${recordId}:`, errText);
    return { ok: false, recordId, error: errText };
  }

  // Every status move is now a real, attributed Activity Log entry —
  // this used to be silent. Status changes are the single most common
  // thing a technician actually does to a job, so leaving them
  // unlogged meant "who's actually working this" could only be
  // inferred from comments, checklist ticks, or procurement actions —
  // missing the most basic signal entirely.
  if (closedByUsername) {
    await appendActivityLog(recordId, `📍 Status changed to ${status}`, closedByUsername, "system");
  }

  return { ok: true, recordId };
}

// Approves the finished work — the routed role's sign-off is what
// actually closes a work order now, not the technician's own say-so.
// Carries the same asset-rollover and satisfaction-request logic that
// used to live in the direct-close path, since this is the only place
// "Completed" is ever reached from now on.
async function handleApproveClosure(req, res, approvedByUsername) {
  const { recordId } = req.body || {};
  if (!recordId) return res.status(400).json({ error: "recordId required" });

  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");

  try {
    const woResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!woResp.ok) throw new Error("Could not read work order");
    const woData = await woResp.json();

    if (woData.fields["Status"] !== "Ready for Review") {
      return res.status(400).json({ error: "This work order isn't waiting for review — nothing to approve." });
    }

    const assetIdForRollover = woData.fields["Asset ID"];
    const reporterContact = woData.fields["Reporter Contact"];
    const assetName = woData.fields["Asset Name"] || "the reported issue";

    const patchResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          "Status": "Completed",
          "Completed Date": new Date().toISOString(),
          "Closed By": approvedByUsername,
          "Closure Rejection Reason": "",
        },
      }),
    });
    if (!patchResp.ok) throw new Error("Could not approve closure");

    if (assetIdForRollover) await advanceAssetNextService(assetIdForRollover);
    if (reporterContact) await sendSatisfactionRequest(reporterContact, recordId, assetName);
    await appendActivityLog(recordId, `✅ Work approved and closed by ${approvedByUsername}`, approvedByUsername, "system");

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("handleApproveClosure error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Rejects the finished work — sends it back to the technician as still
// open, with a reason attached, instead of a dead end.
async function handleRejectClosure(req, res, rejectedByUsername) {
  const { recordId, reason } = req.body || {};
  if (!recordId || !reason) return res.status(400).json({ error: "recordId and reason required" });

  const base = process.env.AIRTABLE_BASE_ID;
  const table = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");

  try {
    const patchResp = await fetch(`https://api.airtable.com/v0/${base}/${table}/${recordId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { "Status": "In Progress", "Closure Rejection Reason": reason } }),
    });
    if (!patchResp.ok) throw new Error("Could not reject closure");

    await appendActivityLog(recordId, `❌ Work sent back by ${rejectedByUsername} — ${reason}`, rejectedByUsername, "system");
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("handleRejectClosure error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Sends the reporter a simple confirm/deny link once their issue is
// marked Completed — the same link works whether it arrives by email
// or SMS, since it's just a plain URL. Detects channel by presence of
// "@" rather than asking the reporter to pick one.
// Fires the moment procurement is requested — emails the specific
// person whose job it actually is to approve, matching the work
// order's own routed role (Electrical/Mechanical Engineer, Admin, or
// Property Manager — whichever discipline this job actually belongs
// to), not funneled to Engineers only.
// Fires when a core role assigns a specific technician — both email
// and SMS, since this is the "go do this job" moment and shouldn't
// depend on someone happening to check their inbox.
async function notifyTechnicianOfAssignment(technicianContact, woId, assetName) {
  const fromName = process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager";
  if (technicianContact.email) {
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
        <div style="background:#1A3566;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;opacity:0.85">You've Been Assigned</div>
          <div style="font-size:18px;font-weight:700;margin-top:4px">${assetName} — ${woId}</div>
        </div>
        <div style="border:1px solid #E2E6ED;border-top:none;border-radius:0 0 8px 8px;padding:20px">
          <p style="margin:0;color:#1A1A2E;font-size:14px;line-height:1.6">Please confirm or decline this assignment in the app before starting work.</p>
        </div>
      </div>`;
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${fromName} <${process.env.ALERT_FROM_EMAIL}>`,
        to: [technicianContact.email],
        subject: `You've been assigned — ${assetName} (${woId})`,
        html,
      }),
    }).catch(err => console.error("notifyTechnicianOfAssignment email error:", err));
  }
  if (technicianContact.phone) {
    try {
      const message = sanitizeForSmsWO(`You've been assigned ${woId} - ${assetName}. Confirm or decline in the app.`);
      const auth = Buffer.from(`${process.env.BEEM_API_KEY}:${process.env.BEEM_SECRET_KEY}`).toString("base64");
      await fetch("https://apisms.beem.africa/v1/send", {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          source_addr: process.env.BEEM_SENDER_ID || "INFO",
          schedule_time: "",
          encoding: 0,
          message: message.slice(0, 300),
          recipients: [{ recipient_id: 1, dest_addr: technicianContact.phone }],
        }),
      });
    } catch (err) {
      console.error("notifyTechnicianOfAssignment SMS error:", err);
    }
  }
}

// A short confirmation email back to whoever did the assigning — "yes,
// this went through." Not urgent enough for SMS.
async function notifyAssignerConfirmation(assignerUsername, technicianUsername, woId, assetName) {
  const assignerContact = getContactForUsername(assignerUsername);
  if (!assignerContact || !assignerContact.email) return;
  const fromName = process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager";
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
      <div style="background:#1A3566;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;opacity:0.85">Assignment Confirmation</div>
        <div style="font-size:18px;font-weight:700;margin-top:4px">${assetName} — ${woId}</div>
      </div>
      <div style="border:1px solid #E2E6ED;border-top:none;border-radius:0 0 8px 8px;padding:20px">
        <p style="margin:0;color:#1A1A2E;font-size:14px;line-height:1.6">You assigned ${technicianUsername} to this job. They've been notified and asked to confirm.</p>
      </div>
    </div>`;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${fromName} <${process.env.ALERT_FROM_EMAIL}>`,
      to: [assignerContact.email],
      subject: `Assigned ${technicianUsername} — ${assetName} (${woId})`,
      html,
    }),
  }).catch(err => console.error("notifyAssignerConfirmation error:", err));
}

// Fires when a technician declines — the assigner needs to know
// promptly since the job is now sitting unassigned again.
async function notifyAssignerOfDecline(assignerEmail, technicianUsername, reason, woId, assetName) {
  const fromName = process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager";
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
      <div style="background:#991B1B;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;opacity:0.85">Assignment Declined</div>
        <div style="font-size:18px;font-weight:700;margin-top:4px">${assetName} — ${woId}</div>
      </div>
      <div style="border:1px solid #E2E6ED;border-top:none;border-radius:0 0 8px 8px;padding:20px">
        <p style="margin:0;color:#1A1A2E;font-size:14px;line-height:1.6">${technicianUsername} declined this assignment: "${reason}". Please assign someone else.</p>
      </div>
    </div>`;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${fromName} <${process.env.ALERT_FROM_EMAIL}>`,
      to: [assignerEmail],
      subject: `Declined — ${assetName} (${woId}) needs reassignment`,
      html,
    }),
  }).catch(err => console.error("notifyAssignerOfDecline error:", err));
}

async function notifyEngineerOfProcurementRequest(recordId, woId, assetName, assignedRole, requestedBy, total) {
  const routedLoginRole = ASSIGNED_ROLE_TO_LOGIN_ROLE[assignedRole];
  const directory = getAllStaffDirectory();
  const toList = directory.filter(e => e.role === routedLoginRole || e.role === "business_owner" || e.role === "system_admin").map(e => e.email).filter(Boolean);
  if (toList.length === 0) return;

  const fromName = process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager";
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
      <div style="background:#B45309;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;opacity:0.85">Procurement Request</div>
        <div style="font-size:18px;font-weight:700;margin-top:4px">${assetName} — ${woId}</div>
      </div>
      <div style="border:1px solid #E2E6ED;border-top:none;border-radius:0 0 8px 8px;padding:20px">
        <p style="margin:0;color:#1A1A2E;font-size:14px;line-height:1.6">TZS ${total.toLocaleString()} requested by ${requestedBy}. Your approval is needed before this can proceed.</p>
      </div>
    </div>`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${fromName} <${process.env.ALERT_FROM_EMAIL}>`,
      to: toList,
      subject: `Procurement approval needed — ${assetName} (${woId})`,
      html,
    }),
  }).catch(err => console.error("notifyEngineerOfProcurementRequest error:", err));
}

// Fires the moment an Engineer approves — emails whoever holds the
// Procurement role, since they're the ones who actually pay and
// fulfill it next, not just an activity log entry nobody's watching.
async function notifyProcurementOfApproval(woId, assetName, total, approvedBy) {
  const directory = getAllStaffDirectory();
  const toList = directory.filter(e => e.role === "procurement").map(e => e.email).filter(Boolean);
  if (toList.length === 0) return;

  const fromName = process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager";
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
      <div style="background:#1A3566;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;opacity:0.85">Approved — Payment Needed</div>
        <div style="font-size:18px;font-weight:700;margin-top:4px">${assetName} — ${woId}</div>
      </div>
      <div style="border:1px solid #E2E6ED;border-top:none;border-radius:0 0 8px 8px;padding:20px">
        <p style="margin:0;color:#1A1A2E;font-size:14px;line-height:1.6">TZS ${total.toLocaleString()} approved by ${approvedBy}. Ready for payment.</p>
      </div>
    </div>`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${fromName} <${process.env.ALERT_FROM_EMAIL}>`,
      to: toList,
      subject: `Ready for payment — ${assetName} (${woId})`,
      html,
    }),
  }).catch(err => console.error("notifyProcurementOfApproval error:", err));
}

// Fires the moment procurement is fulfilled — emails the routed role
// (Engineer, Admin, or Property Manager — whoever owns this job), not
// the technician directly. The routed role is the one who then tells
// the technician to proceed; the system doesn't SMS the technician.
async function notifyRoutedRoleOfFulfillment(assignedRole, assetName, woId, total) {
  const routedLoginRole = ASSIGNED_ROLE_TO_LOGIN_ROLE[assignedRole];
  const directory = getAllStaffDirectory();
  const toList = directory.filter(e => e.role === routedLoginRole || e.role === "business_owner" || e.role === "system_admin").map(e => e.email).filter(Boolean);
  if (toList.length === 0) return;

  const fromName = process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager";
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
      <div style="background:#16a34a;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;opacity:0.85">Payment Processed</div>
        <div style="font-size:18px;font-weight:700;margin-top:4px">${assetName} — ${woId}</div>
      </div>
      <div style="border:1px solid #E2E6ED;border-top:none;border-radius:0 0 8px 8px;padding:20px">
        <p style="margin:0;color:#1A1A2E;font-size:14px;line-height:1.6">TZS ${total.toLocaleString()} payment processed. Let the technician know they can proceed.</p>
      </div>
    </div>`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${fromName} <${process.env.ALERT_FROM_EMAIL}>`,
      to: toList,
      subject: `Payment processed — technician can proceed: ${assetName} (${woId})`,
      html,
    }),
  }).catch(err => console.error("notifyRoutedRoleOfFulfillment error:", err));
}

async function sendSatisfactionRequest(contact, recordId, assetName) {
  const appUrl = process.env.APP_BASE_URL || "https://zanzibar-one-fam-automation.vercel.app";
  const yesLink = `${appUrl}/api/report-issue?satisfaction=yes&recordId=${recordId}`;
  const noLink = `${appUrl}/api/report-issue?satisfaction=no&recordId=${recordId}`;
  const isEmail = contact.includes("@");

  try {
    if (isEmail) {
      const fromName = process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager";
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
          <div style="background:#1A3566;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
            <div style="font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;opacity:0.85">Work Completed</div>
            <div style="font-size:18px;font-weight:700;margin-top:4px">${assetName}</div>
          </div>
          <div style="border:1px solid #E2E6ED;border-top:none;border-radius:0 0 8px 8px;padding:20px">
            <p style="margin:0 0 16px;color:#1A1A2E;font-size:14px;line-height:1.6">Are you satisfied with how this was resolved?</p>
            <a href="${yesLink}" style="background:#16a34a;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;margin-right:10px;font-size:13px;font-weight:600">Yes, I'm satisfied</a>
            <a href="${noLink}" style="background:#dc2626;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600">No, still a problem</a>
          </div>
        </div>`;
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `${fromName} <${process.env.ALERT_FROM_EMAIL}>`,
          to: [contact],
          subject: `Are you satisfied with the fix? — ${assetName}`,
          html,
        }),
      });
    } else {
      const rawMessage = `Are you satisfied with how "${assetName}" was resolved? Yes: ${yesLink} No: ${noLink}`;
      const cleanMessage = sanitizeForSmsWO(rawMessage);
      const auth = Buffer.from(`${process.env.BEEM_API_KEY}:${process.env.BEEM_SECRET_KEY}`).toString("base64");
      await fetch("https://apisms.beem.africa/v1/send", {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          source_addr: process.env.BEEM_SENDER_ID || "INFO",
          schedule_time: "",
          encoding: 0,
          message: cleanMessage.slice(0, 300),
          recipients: [{ recipient_id: 1, dest_addr: contact }],
        }),
      });
    }
  } catch (err) {
    console.error("sendSatisfactionRequest error:", err);
  }
}

// Same sanitizer used everywhere else — Beem's GSM-7 encoding rejects
// smart quotes and em-dashes, which asset/description text often has.
function sanitizeForSmsWO(text) {
  return text
    .replace(/[\u2014\u2013]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/[^\x00-\x7F]/g, "");
}

// Rolls the linked Component's maintenance date forward the same way a
// real technician would log "serviced today, next due in X." Interval
// comes from the asset's own "Maintenance Interval (Days)" field if set,
// otherwise defaults to 90 days. This is what actually closes the loop
// and stops the false repeat-alert bug.
async function advanceAssetNextService(assetId) {
  const base = process.env.AIRTABLE_BASE_ID;
  const componentsTable = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");

  const findUrl = new URL(`https://api.airtable.com/v0/${base}/${componentsTable}`);
  findUrl.searchParams.set("filterByFormula", `{Asset ID} = "${assetId.replace(/"/g, '\\"')}"`);
  findUrl.searchParams.set("maxRecords", "1");

  const findResp = await fetch(findUrl.toString(), {
    headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
  });
  if (!findResp.ok) {
    console.error("advanceAssetNextService: could not look up asset", assetId);
    return;
  }
  const findData = await findResp.json();
  const record = findData.records && findData.records[0];
  if (!record) {
    console.error("advanceAssetNextService: no Component found for", assetId);
    return;
  }

  const intervalDays = Number(record.fields["Maintenance Interval (Days)"]) || 90;
  const today = new Date();
  const nextDue = new Date(today);
  nextDue.setDate(nextDue.getDate() + intervalDays);

  await fetch(`https://api.airtable.com/v0/${base}/${componentsTable}/${record.id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: {
        "Last Service": today.toISOString().split("T")[0],
        "Next Service Due": nextDue.toISOString().split("T")[0],
      },
    }),
  });
}

async function handleMaintenanceReport(req, res) {
  const { status, from, to, asset } = req.query;
  try {
    const records = await fetchAllWorkOrders();
    let filtered = records;
    if (status) filtered = filtered.filter(r => (r.fields["Status"] || "") === status);
    if (asset) filtered = filtered.filter(r => (r.fields["Asset ID"] || "") === asset);
    if (from) { const d = new Date(from); filtered = filtered.filter(r => r.fields["Created"] && new Date(r.fields["Created"]) >= d); }
    if (to) { const d = new Date(to); d.setHours(23,59,59,999); filtered = filtered.filter(r => r.fields["Created"] && new Date(r.fields["Created"]) <= d); }
    const workOrders = filtered.map(r => ({
      woId: r.fields["WO ID"] || "", assetId: r.fields["Asset ID"] || "",
      assetName: r.fields["Asset Name"] || "", system: r.fields["System"] || "",
      location: r.fields["Location"] || "", status: r.fields["Status"] || "Open",
      urgency: r.fields["Urgency"] || "", maintenanceType: r.fields["Maintenance Type"] || "", created: r.fields["Created"] || "",
      completedDate: r.fields["Completed Date"] || "", closedBy: r.fields["Closed By"] || "",
      cost: r.fields["Cost (TZS)"] || null, costEditedBy: r.fields["Cost Edited By"] || "", costEditedDate: r.fields["Cost Edited Date"] || "", checklistProgress: r.fields["Checklist Progress"] || "{}", activityLog: r.fields["Activity Log"] || "[]", chatLog: r.fields["Chat Log"] || "[]", chatParticipants: r.fields["Chat Participants"] || "[]", chatReadReceipts: r.fields["Chat Read Receipts"] || "{}", assignedRole: r.fields["Assigned Role"] || "", assignedRoleSetBy: r.fields["Assigned Role Set By"] || "", assignedTechnician: r.fields["Assigned Technician"] || "", assignedTechnicianSetBy: r.fields["Assigned Technician Set By"] || "", assignmentStatus: r.fields["Assignment Status"] || "", externalAssigneeName: r.fields["External Assignee Name"] || "", externalAssigneeContact: r.fields["External Assignee Contact"] || "", procurementStatus: r.fields["Procurement Status"] || "None", costBreakdown: r.fields["Cost Breakdown"] || "[]", procurementRequestedBy: r.fields["Procurement Requested By"] || "", procurementApprovedBy: r.fields["Procurement Approved By"] || "", procurementRejectionReason: r.fields["Procurement Rejection Reason"] || "", beforePhoto: (r.fields["Before Photo"] || [])[0] ? r.fields["Before Photo"][0].url : null, afterPhoto: (r.fields["After Photo"] || [])[0] ? r.fields["After Photo"][0].url : null, reporterContact: r.fields["Reporter Contact"] || "", reporterPhoto: (r.fields["Reporter Photo"] || [])[0] ? r.fields["Reporter Photo"][0].url : null, satisfactionStatus: r.fields["Satisfaction Status"] || "", satisfactionReason: r.fields["Satisfaction Reason"] || "", closureRejectionReason: r.fields["Closure Rejection Reason"] || "",
      notes: r.fields["Notes"] || "",
    })).sort((a, b) => new Date(b.created) - new Date(a.created));

    // Cost totals by maintenance type — this is the actual "invisible
    // maintenance tax" comparison: scheduled (Preventive) spend vs.
    // reactive (Corrective) spend, from real recorded costs.
    const costByType = {};
    workOrders.forEach(w => {
      if (w.cost === null) return;
      const type = w.maintenanceType || "Unspecified";
      costByType[type] = (costByType[type] || 0) + w.cost;
    });

    const summary = {
      total: workOrders.length, open: workOrders.filter(w => w.status === "Open").length,
      inProgress: workOrders.filter(w => w.status === "In Progress").length,
      completed: workOrders.filter(w => w.status === "Completed").length,
      costByMaintenanceType: costByType,
      totalCostRecorded: Object.values(costByType).reduce((a,b) => a+b, 0),
    };
    return res.status(200).json({ workOrders, summary });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// Manually schedules an Inspection-type work order for a specific asset —
// distinct from Preventive (auto-generated by the daily cron) and
// Corrective (auto-generated from a breakdown report). This is how
// someone books a compliance/verification check (guideline Section 18)
// that isn't tied to the asset's regular service schedule.
async function handleScheduleInspection(req, res, scheduledBy) {
  const { assetId, notes } = req.body || {};
  if (!assetId) {
    return res.status(400).json({ error: "assetId required" });
  }

  const base = process.env.AIRTABLE_BASE_ID;
  const componentsTable = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
  const woTable = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");

  try {
    // Look up the asset so the work order has real Name/System/Location, same as other WO types
    const findUrl = new URL(`https://api.airtable.com/v0/${base}/${componentsTable}`);
    findUrl.searchParams.set("filterByFormula", `{Asset ID} = "${assetId.replace(/"/g, '\\"')}"`);
    findUrl.searchParams.set("maxRecords", "1");
    const findResp = await fetch(findUrl.toString(), {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!findResp.ok) throw new Error("Could not look up asset");
    const findData = await findResp.json();
    const record = findData.records && findData.records[0];
    if (!record) return res.status(404).json({ error: `Asset "${assetId}" not found` });
    const f = record.fields;

    const woId = `WO-${Date.now()}`;
    const baseFields = {
      "WO ID": woId,
      "Asset ID": f["Asset ID"] || assetId,
      "Asset Name": f["Name"] || "",
      "System": f["System"] || "",
      "Location": f["Room/Zone"] || "",
      "Status": "Open",
      "Urgency": "SCHEDULED",
      "Created": new Date().toISOString(),
      "Notes": notes || `Inspection scheduled by ${scheduledBy}`,
      "Assigned Role": getAssignedRole(f["System"], f["Name"]) || undefined,
    };

    let createResp = await fetch(`https://api.airtable.com/v0/${base}/${woTable}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { ...baseFields, "Maintenance Type": "Inspection" } }),
    });

    if (!createResp.ok) {
      const firstErr = await createResp.text();
      console.error("Inspection creation with Maintenance Type failed, retrying without it:", firstErr);
      createResp = await fetch(`https://api.airtable.com/v0/${base}/${woTable}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: baseFields }),
      });
    }

    if (!createResp.ok) {
      const errText = await createResp.text();
      throw new Error("Failed to create inspection work order: " + createResp.status + " " + errText);
    }

    const created = await createResp.json();
    return res.status(200).json({ success: true, woId, recordId: created.id });
  } catch (err) {
    console.error("handleScheduleInspection error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Spare-part ordering directly from an asset — no breakdown, no
// reported issue required. Confirmed with Grace: a work order isn't
// only a breakdown anymore, it's the general container for anything
// that needs acting on for an asset, including a proactive parts
// order. This creates a lightweight shell work order, tagged with its
// own Maintenance Type ("Procurement") so it's clearly distinguishable
// from real repair work — then the caller immediately opens the
// EXISTING procurement-request flow on it (openProcurementRequestModal
// on the frontend). Same request -> approve -> fulfill pipeline as
// every other procurement request. No second workflow.
async function handleOrderSparePart(req, res, orderedBy) {
  const { assetId } = req.body || {};
  if (!assetId) {
    return res.status(400).json({ error: "assetId required" });
  }

  const base = process.env.AIRTABLE_BASE_ID;
  const componentsTable = encodeURIComponent(process.env.AIRTABLE_TABLE_NAME || "Components");
  const woTable = encodeURIComponent(process.env.AIRTABLE_WORK_ORDERS_TABLE || "Work Orders");

  try {
    // Look up the asset so the work order has real Name/System/Location, same as every other WO type
    const findUrl = new URL(`https://api.airtable.com/v0/${base}/${componentsTable}`);
    findUrl.searchParams.set("filterByFormula", `{Asset ID} = "${assetId.replace(/"/g, '\\"')}"`);
    findUrl.searchParams.set("maxRecords", "1");
    const findResp = await fetch(findUrl.toString(), {
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}` },
    });
    if (!findResp.ok) throw new Error("Could not look up asset");
    const findData = await findResp.json();
    const record = findData.records && findData.records[0];
    if (!record) return res.status(404).json({ error: `Asset "${assetId}" not found` });
    const f = record.fields;

    const woId = `WO-${Date.now()}`;
    const baseFields = {
      "WO ID": woId,
      "Asset ID": f["Asset ID"] || assetId,
      "Asset Name": f["Name"] || "",
      "System": f["System"] || "",
      "Location": f["Room/Zone"] || "",
      "Status": "Open",
      "Urgency": "SCHEDULED",
      "Created": new Date().toISOString(),
      "Notes": `Spare part order initiated by ${orderedBy} for ${f["Name"] || assetId}`,
      "Assigned Role": getAssignedRole(f["System"], f["Name"]) || undefined,
    };

    let createResp = await fetch(`https://api.airtable.com/v0/${base}/${woTable}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { ...baseFields, "Maintenance Type": "Procurement" } }),
    });

    if (!createResp.ok) {
      const firstErr = await createResp.text();
      // "Procurement" needs adding as a choice on the Maintenance Type
      // singleSelect field in Airtable — same one-time manual step as
      // adding "External" to Assigned Role earlier. Falls back to no
      // type in the meantime rather than failing the whole request.
      console.error("Spare-part WO creation with Maintenance Type failed, retrying without it — add \"Procurement\" as a Maintenance Type choice in Airtable to fix permanently:", firstErr);
      createResp = await fetch(`https://api.airtable.com/v0/${base}/${woTable}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: baseFields }),
      });
    }

    if (!createResp.ok) {
      const errText = await createResp.text();
      throw new Error("Failed to create spare-part work order: " + createResp.status + " " + errText);
    }

    const created = await createResp.json();
    return res.status(200).json({ success: true, woId, recordId: created.id });
  } catch (err) {
    console.error("handleOrderSparePart error:", err);
    return res.status(500).json({ error: err.message });
  }
}
