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
// Electrical, Admin, Property Manager). Login roles are
// the actual permission-checked identities (mechanical_engineer,
// etc). This maps one to the other so closure sign-off can verify the
// specific person reviewing is actually who the job was routed to.
// Shared by closure review AND procurement approve/reject — Business
// Owner / System Admin can act on any work order; every other routed
// role must match the specific role this work order was actually
// assigned to. Returns null if allowed, or an error message if not.
async function checkRoutedRoleMatch(session, recordId) {
  if (session.r === "business_owner" || session.r === "system_admin") return null;
  const { getById } = await import("../lib/postgresClient.js");
  const checkData = await getById("work_orders", recordId).catch(() => null);
  if (!checkData) return null; // fail open ONLY on a read error — a network/API failure, not a routing gap
  const assignedRole = checkData.assigned_role;

  const expectedLoginRole = ASSIGNED_ROLE_TO_LOGIN_ROLE[assignedRole];
  // Fail CLOSED on anything unmapped (missing, unrecognized, or a
  // stray value — including any leftover "External" from before this
  // was removed as a routing option entirely) — an unrouted work order
  // should never silently let just anyone through.
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

// Signs a work order's three possible photo paths (before/after/
// reporter) in parallel — shared by the main GET handler and
// handleMaintenanceReport, which both need the identical mapping.
// Each column stores a storage PATH, not a URL; a single photo
// failing to sign falls back to null for that one field rather than
// failing the whole row.
async function signWorkOrderPhotos(r) {
  const { getSignedUrlSafe } = await import("../lib/storageClient.js");
  const [beforePhoto, afterPhoto, reporterPhoto] = await Promise.all([
    getSignedUrlSafe(r.before_photo_url).catch(err => { console.error("signWorkOrderPhotos: before photo", err.message); return null; }),
    getSignedUrlSafe(r.after_photo_url).catch(err => { console.error("signWorkOrderPhotos: after photo", err.message); return null; }),
    getSignedUrlSafe(r.reporter_photo_url).catch(err => { console.error("signWorkOrderPhotos: reporter photo", err.message); return null; }),
  ]);
  return { beforePhoto, afterPhoto, reporterPhoto };
}

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

  // Vendor directory — the foundation the whole new procurement flow
  // sits on. Simple list, no pagination needed at this scale.
  if (req.method === "GET" && req.query.vendors === "true") {
    return handleGetVendors(req, res);
  }

  // Vendor quotes for one work order — the actual "compare and choose
  // the lowest bidder" data. Scoped by WO ID via filterByFormula rather
  // than fetching everything, since this table will grow with every
  // procurement request across every work order.
  if (req.method === "GET" && req.query.procurementResponses) {
    return handleGetProcurementResponses(req, res, req.query.procurementResponses);
  }

  if (req.method === "GET") {
    try {
      const records = await fetchAllWorkOrders();
      const workOrders = await Promise.all(records.map(async r => {
        const { beforePhoto, afterPhoto, reporterPhoto } = await signWorkOrderPhotos(r);
        const { signChatLogAttachments } = await import("../lib/storageClient.js");
        const signedChatLog = await signChatLogAttachments(r.chat_log || []);
        return {
          id: r.id,
          woId: r.wo_id || "",
          assetId: r.asset_id || "",
          assetName: r.asset_name || "",
          system: r.system || "",
          location: r.location || "",
          status: r.status || "Open",
          urgency: r.urgency || "",
          maintenanceType: r.maintenance_type || "",
          created: r.created || "",
          completedDate: r.completed_date || "",
          closedBy: r.closed_by || "",
          cost: r.cost_tzs !== null ? Number(r.cost_tzs) : null,
          costEditedBy: r.cost_edited_by || "",
          costEditedDate: r.cost_edited_date || "",
          // These four originally arrived pre-JSON-encoded as strings
          // from Airtable; jsonb columns come back already-parsed from
          // Postgres, so re-stringified here to preserve the exact
          // same shape the frontend already expects.
          checklistProgress: JSON.stringify(r.checklist_progress || {}),
          activityLog: JSON.stringify(r.activity_log || []),
          chatLog: JSON.stringify(signedChatLog),
          chatParticipants: JSON.stringify(r.chat_participants || []),
          chatReadReceipts: JSON.stringify(r.chat_read_receipts || {}),
          assignedRole: r.assigned_role || "",
          assignedRoleSetBy: r.assigned_role_set_by || "",
          building: r.building || "",
          assignedTechnician: r.assigned_technician || "",
          assignedTechnicianSetBy: r.assigned_technician_set_by || "",
          unit: r.unit || "",
          nonAssetConfirmed: r.non_asset_confirmed || false,
          assetIdSetBy: r.asset_id_set_by || "",
          assignmentStatus: r.assignment_status || "",
          procurementStatus: r.procurement_status || "None",
          costBreakdown: JSON.stringify(r.cost_breakdown || []),
          procurementRequestedBy: r.procurement_requested_by || "",
          procurementApprovedBy: r.procurement_approved_by || "",
          procurementRejectionReason: r.procurement_rejection_reason || "",
          beforePhoto,
          afterPhoto,
          reporterContact: r.reporter_contact || "",
          reporterPhoto,
          satisfactionStatus: r.satisfaction_status || "",
          satisfactionReason: r.satisfaction_reason || "",
          closureRejectionReason: r.closure_rejection_reason || "",
          notes: r.notes || "",
        };
      }));
      workOrders.sort((a, b) => new Date(b.created) - new Date(a.created));
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
    // Procurement request — description + quantity only, confirmed.
    // Whoever requests it genuinely cannot price anything, so there's
    // nothing to enter beyond what's needed. Goes straight to
    // Procurement — no engineer approval gate exists anymore; the
    // engineer's only remaining involvement is specifying this, and
    // confirming delivery at the very end (confirmDelivery, below).
    if (req.body && req.body.requestProcurement) {
      const { recordId, description, quantity, unit } = req.body;
      if (!recordId || !description || !description.trim() || !quantity) {
        return res.status(400).json({ error: "recordId, description, and quantity are required" });
      }
      try {
        const { getById, update } = await import("../lib/postgresClient.js");

        const current = await getById("work_orders", recordId).catch(() => ({}));

        const spec = { description: description.trim(), quantity, unit: (unit || "").trim() };

        await update("work_orders", recordId, {
          procurement_status: "Requested",
          // Reusing the existing cost_breakdown column for the new,
          // simpler spec shape — no new column needed. It no longer
          // holds pricing, just what's actually needed.
          cost_breakdown: JSON.stringify([spec]),
          procurement_requested_by: session.u,
          procurement_rejection_reason: null,
        }).catch(() => { throw new Error("Could not save procurement request"); });
        await appendActivityLog(recordId, `🛒 Procurement requested — ${spec.description} (${spec.quantity}${spec.unit ? " " + spec.unit : ""})`, session.u, "procurement_request");
        await notifyProcurementOfRequest(current.wo_id || "", current.asset_name || "Unnamed", session.u, spec);
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("requestProcurement error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Procurement fulfilling a request — enters the final cost
    // themselves now, since the requester never priced anything.
    // Interim: once vendor quotes (Procurement Responses) are wired
    // in, this can pull the Chosen quote's AI-extracted cost
    // automatically instead of a manual number — not built yet, so
    // this asks for it directly rather than assuming data that doesn't
    // exist.
    if (req.body && req.body.fulfillProcurement) {
      if (!can(session.r, "fulfillProcurement")) return res.status(403).json({ error: "Not permitted to fulfill procurement" });
      const { recordId, finalCost } = req.body;
      if (!recordId || finalCost === undefined || finalCost === null || finalCost === "") {
        return res.status(400).json({ error: "recordId and finalCost are required" });
      }
      try {
        const { getById, update } = await import("../lib/postgresClient.js");

        const current = await getById("work_orders", recordId).catch(() => ({}));
        const total = Number(finalCost) || 0;

        await update("work_orders", recordId, { procurement_status: "Fulfilled", cost_tzs: total, cost_edited_by: session.u, cost_edited_date: new Date().toISOString() })
          .catch(() => { throw new Error("Could not mark procurement fulfilled"); });
        await appendActivityLog(recordId, `📦 Payment processed by ${session.u} — TZS ${total.toLocaleString()} recorded, delivery note sent to routed role`, session.u, "system");
        await notifyRoutedRoleOfDeliveryArrival(current.assigned_role, current.asset_name || "Unnamed", current.wo_id || "", total);

        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("fulfillProcurement error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Delivery confirmation — the new replacement for the old approval
    // gate, but at the END of the flow instead of the beginning, and
    // it confirms receipt rather than authorizing spend. Not a hard
    // block on the technician completing the job — same "visible,
    // logged, not a wall" principle used elsewhere in this system.
    // Reuses the existing "Procurement Approved By" field to record who
    // confirmed — same field, repurposed meaning, no new Airtable field.
    if (req.body && req.body.confirmDelivery) {
      const { recordId } = req.body;
      if (!recordId) return res.status(400).json({ error: "recordId required" });
      const roleError = await checkRoutedRoleMatch(session, recordId);
      if (roleError) return res.status(403).json({ error: roleError });
      try {
        const { update } = await import("../lib/postgresClient.js");
        await update("work_orders", recordId, { procurement_status: "Delivered", procurement_approved_by: session.u })
          .catch(() => { throw new Error("Could not confirm delivery"); });
        await appendActivityLog(recordId, `📬 Delivery confirmed by ${session.u}`, session.u, "system");
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("confirmDelivery error:", err);
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
        const { getById, update } = await import("../lib/postgresClient.js");

        const woData = await getById("work_orders", recordId).catch(() => { throw new Error("Could not read work order"); });

        const log = Array.isArray(woData.activity_log) ? woData.activity_log : [];

        log.push({
          type: entryType || "comment", // comment / procurement_request / system
          text,
          by: session.u,
          at: new Date().toISOString(),
        });

        await update("work_orders", recordId, { activity_log: JSON.stringify(log) })
          .catch(() => { throw new Error("Could not save activity entry"); });

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
      const { recordId, text, attachmentBase64, attachmentFilename, attachmentContentType } = req.body;
      if (!recordId) return res.status(400).json({ error: "recordId required" });
      if (!text && !attachmentBase64) return res.status(400).json({ error: "A message needs text or an attachment" });

      try {
        const { getById, update } = await import("../lib/postgresClient.js");

        // Upload first, if there's a file — the message entry just
        // references the resulting path (signed into a real URL fresh
        // on every read, not stored as a URL — see storageClient.js).
        let attachmentPath = null;
        if (attachmentBase64) {
          const { uploadFile } = await import("../lib/storageClient.js");
          attachmentPath = `work-orders/${recordId}/chat/${Date.now()}-${attachmentFilename || "file"}`;
          await uploadFile(attachmentPath, attachmentBase64, attachmentContentType || "application/octet-stream");
        }

        const woData = await getById("work_orders", recordId).catch(() => { throw new Error("Could not read work order"); });

        const chatLog = Array.isArray(woData.chat_log) ? woData.chat_log : [];
        const entry = { text: text || "", by: session.u, at: new Date().toISOString() };
        if (attachmentPath) { entry.attachmentPath = attachmentPath; entry.attachmentFilename = attachmentFilename || ""; entry.attachmentType = attachmentContentType || ""; }
        chatLog.push(entry);

        // Sending a message means you've obviously seen everything up
        // to that point — stamp your own read receipt in the same
        // write, so you never see your own message as "unread."
        const readReceipts = (woData.chat_read_receipts && typeof woData.chat_read_receipts === "object") ? woData.chat_read_receipts : {};
        readReceipts[session.u] = new Date().toISOString();

        await update("work_orders", recordId, { chat_log: JSON.stringify(chatLog), chat_read_receipts: JSON.stringify(readReceipts) })
          .catch(() => { throw new Error("Could not save chat message"); });

        const { signChatLogAttachments } = await import("../lib/storageClient.js");
        const signedChatLog = await signChatLogAttachments(chatLog);

        return res.status(200).json({ success: true, chatLog: signedChatLog, chatReadReceipts: readReceipts });
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
        const { getById, update } = await import("../lib/postgresClient.js");

        const woData = await getById("work_orders", recordId).catch(() => { throw new Error("Could not read work order"); });

        const readReceipts = (woData.chat_read_receipts && typeof woData.chat_read_receipts === "object") ? woData.chat_read_receipts : {};
        readReceipts[session.u] = new Date().toISOString();

        await update("work_orders", recordId, { chat_read_receipts: JSON.stringify(readReceipts) })
          .catch(() => { throw new Error("Could not save read receipt"); });

        return res.status(200).json({ success: true, chatReadReceipts: readReceipts });
      } catch (err) {
        console.error("markChatRead error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Reassigning a work order's routed role. Confirmed use cases:
    // correcting a "Not sure" report that landed on the wrong
    // discipline, or a core role realizing a job belongs to a
    // different discipline than it's currently routed to. Just an
    // edit to the field — no separate reassignment history table.
    // Only the four internal disciplines are valid here — External is
    // deliberately NOT a reassignment option. Engaging an outside
    // vendor happens through a normal procurement request made by one
    // of the four core roles, same pipeline as any other purchase, not
    // by changing who a work order is routed to.
    //
    // Reassignment (discipline-level) — broadened to match technician
    // assignment exactly: any of the four core roles can reassign any
    // work order's routing, regardless of who currently holds it.
    // Confirmed: this covers both directions — a Property Manager
    // realizing an issue is actually electrical and routing it to the
    // Electrical Engineer, or any core role correcting a
    // misrouted "Not sure" report — without needing Admin or the
    // current holder specifically to be the one who fixes it.
    if (req.body && req.body.reassignWorkOrder) {
      const { recordId, assignedRole } = req.body;
      const VALID_ROLES = ["Mechanical", "Electrical", "Admin", "Property Manager"];
      if (!recordId || !assignedRole || !VALID_ROLES.includes(assignedRole)) {
        return res.status(400).json({ error: "recordId and a valid assignedRole are required" });
      }

      const CORE_ROLES = ["electrical_engineer", "mechanical_engineer", "admin", "property_manager"];
      const isOverseer = session.r === "business_owner" || session.r === "system_admin";
      if (!isOverseer && !CORE_ROLES.includes(session.r)) {
        return res.status(403).json({ error: "Only Electrical Engineer, Mechanical Engineer, Admin, or Property Manager can reassign a work order." });
      }

      try {
        const { getById, update } = await import("../lib/postgresClient.js");

        const woData = await getById("work_orders", recordId).catch(() => { throw new Error("Could not read work order"); });
        const currentAssignedRole = woData.assigned_role || "";

        await update("work_orders", recordId, { assigned_role: assignedRole, assigned_role_set_by: session.u })
          .catch(() => { throw new Error("Could not save reassignment"); });

        await appendActivityLog(recordId, `🔀 Reassigned from ${currentAssignedRole || "Unassigned"} to ${assignedRole}`, session.u, "system");

        return res.status(200).json({ success: true, assignedRole });
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
        const { getById, update } = await import("../lib/postgresClient.js");

        const woData = await getById("work_orders", recordId).catch(() => { throw new Error("Could not read work order"); });

        await update("work_orders", recordId, {
          assigned_technician: technicianUsername,
          assigned_technician_set_by: session.u,
          assignment_status: "Pending",
        }).catch(() => { throw new Error("Could not save technician assignment"); });

        await appendActivityLog(recordId, `👷 Assigned to ${technicianUsername} by ${session.u}`, session.u, "system");

        const woId = woData.wo_id || "";
        const assetName = woData.asset_name || "";
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
        const { getById, update } = await import("../lib/postgresClient.js");

        const woData = await getById("work_orders", recordId).catch(() => { throw new Error("Could not read work order"); });

        if (woData.assigned_technician !== session.u) {
          return res.status(403).json({ error: "This job isn't assigned to you." });
        }

        await update("work_orders", recordId, { assignment_status: "Confirmed" })
          .catch(() => { throw new Error("Could not confirm assignment"); });

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
        const { getById, update } = await import("../lib/postgresClient.js");

        const woData = await getById("work_orders", recordId).catch(() => { throw new Error("Could not read work order"); });

        if (woData.assigned_technician !== session.u) {
          return res.status(403).json({ error: "This job isn't assigned to you." });
        }
        const assignedBy = woData.assigned_technician_set_by || "";

        await update("work_orders", recordId, { assigned_technician: null, assignment_status: null })
          .catch(() => { throw new Error("Could not decline assignment"); });

        await appendActivityLog(recordId, `❌ Assignment declined by ${session.u}: ${reason.trim()}`, session.u, "system");

        const woId = woData.wo_id || "";
        const assetName = woData.asset_name || "";
        if (assignedBy) {
          const assignerContact = getContactForUsername(assignedBy);
          if (assignerContact && (assignerContact.email || assignerContact.phone)) {
            await notifyAssignerOfDecline(assignerContact, session.u, reason.trim(), woId, assetName);
          }
        }

        return res.status(200).json({ success: true, assignedTechnician: "", assignmentStatus: "" });
      } catch (err) {
        console.error("declineAssignment error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Attaching a real Asset ID to a work order that didn't start with
    // one — mainly reported breakdowns, which never carry an asset
    // since the reporter usually doesn't know which registered item is
    // actually involved. Confirmed with Grace: anyone with system
    // access can do this, no role restriction. Also pulls the real
    // System from the asset record onto the work order — improves
    // checklist matching — but deliberately does NOT touch Assigned
    // Role; the job stays with whoever it was already routed to.
    if (req.body && req.body.attachAssetId) {
      const { recordId, assetId } = req.body;
      if (!recordId || !assetId) {
        return res.status(400).json({ error: "recordId and assetId required" });
      }

      try {
        const { getByColumn, update } = await import("../lib/postgresClient.js");

        const af = await getByColumn("components", "asset_id", assetId).catch(() => { throw new Error("Could not look up asset"); });
        if (!af) return res.status(404).json({ error: `Asset "${assetId}" not found in the register.` });

        await update("work_orders", recordId, {
          asset_id: af.asset_id || assetId,
          asset_name: af.name || "",
          system: af.system || "",
          asset_id_set_by: session.u,
          non_asset_confirmed: false,
        }).catch(() => { throw new Error("Could not attach asset"); });

        await appendActivityLog(recordId, `🔗 Linked to asset ${af.asset_id || assetId} (${af.name || ""}) by ${session.u}`, session.u, "system");

        return res.status(200).json({ success: true, assetId: af.asset_id || assetId, assetName: af.name || "", system: af.system || "" });
      } catch (err) {
        console.error("attachAssetId error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // The other resolution path: someone's actually looked and this
    // genuinely isn't a registered asset (a chair, a fixture). A
    // deliberate action, never automatic — that's what distinguishes
    // "confirmed non-asset" from "nobody's checked yet," so cost
    // summaries can tell the two apart instead of silently merging them.
    if (req.body && req.body.confirmNotRegisteredAsset) {
      const { recordId } = req.body;
      if (!recordId) return res.status(400).json({ error: "recordId required" });

      try {
        const { update } = await import("../lib/postgresClient.js");

        await update("work_orders", recordId, {
          non_asset_confirmed: true,
          asset_id_set_by: session.u,
        }).catch(() => { throw new Error("Could not confirm"); });

        await appendActivityLog(recordId, `✔ Confirmed not a registered asset — by ${session.u}`, session.u, "system");

        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("confirmNotRegisteredAsset error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Adding a vendor — Procurement only, confirmed. This is the
    // foundation the new procurement workflow sits on: vendors have to
    // actually exist in the system before quotes/invoices can be
    // attached against them.
    // Creating a tenant unit — anyone except Technician, confirmed, to
    // keep this simple rather than defining a precise allowed list.
    if (req.body && req.body.addUnit) {
      if (session.r === "technician") {
        return res.status(403).json({ error: "Not permitted to add a unit." });
      }
      const { unitName, building, unitType, tenantName, tenantEmail, tenantPhone, leaseStatus, contractDate } = req.body;
      if (!unitName || !unitName.trim() || !building) {
        return res.status(400).json({ error: "Unit name and building are required" });
      }
      try {
        const { insert } = await import("../lib/postgresClient.js");
        const fields = {
          unit_name: unitName.trim(),
          building,
          unit_type: unitType || null,
          tenant_name: tenantName || null,
          tenant_email: tenantEmail || null,
          tenant_phone: tenantPhone || null,
          lease_status: leaseStatus || "Vacant",
          added_by: session.u,
        };
        if (contractDate) {
          fields.contract_date = contractDate;
          const nextDue = new Date(contractDate);
          nextDue.setMonth(nextDue.getMonth() + 6);
          fields.next_rent_notice_due = nextDue.toISOString().split("T")[0];
        }
        const created = await insert("units", fields, { typecast: true });
        await appendUnitActivityLog(created.id, `🏠 Unit created by ${session.u}${tenantName ? ` — tenant: ${tenantName}` : ''}`, session.u, "system");
        return res.status(200).json({ success: true, unit: {
          id: created.id, name: created.unit_name || "", building: created.building || "",
        } });
      } catch (err) {
        console.error("addUnit error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Editing tenant details — every change lands in Activity, showing
    // exactly what changed, not just that something did. Setting or
    // changing the contract date recomputes next_rent_notice_due (6
    // months out from that date) the same way editing an asset's
    // Install Date recalculates its own next service date elsewhere in
    // this app — one consistent pattern for "here's an anchor date,
    // here's what's due next relative to it."
    if (req.body && req.body.editUnit) {
      if (session.r === "technician") {
        return res.status(403).json({ error: "Not permitted to edit a unit." });
      }
      const { unitId, tenantName, tenantEmail, tenantPhone, leaseStatus, contractDate } = req.body;
      if (!unitId) return res.status(400).json({ error: "unitId required" });
      try {
        const { getById, update } = await import("../lib/postgresClient.js");

        const before = await getById("units", unitId).catch(() => { throw new Error("Could not read unit"); });

        const fields = {};
        const changes = [];
        if (tenantName !== undefined && tenantName !== (before.tenant_name || "")) { fields.tenant_name = tenantName; changes.push(`Tenant Name: "${before.tenant_name || ""}" → "${tenantName}"`); }
        if (tenantEmail !== undefined && tenantEmail !== (before.tenant_email || "")) { fields.tenant_email = tenantEmail; changes.push(`Email: "${before.tenant_email || ""}" → "${tenantEmail}"`); }
        if (tenantPhone !== undefined && tenantPhone !== (before.tenant_phone || "")) { fields.tenant_phone = tenantPhone; changes.push(`Phone: "${before.tenant_phone || ""}" → "${tenantPhone}"`); }
        if (leaseStatus !== undefined && leaseStatus !== (before.lease_status || "")) { fields.lease_status = leaseStatus; changes.push(`Lease Status: "${before.lease_status || ""}" → "${leaseStatus}"`); }
        if (contractDate !== undefined && contractDate !== (before.contract_date || "")) {
          fields.contract_date = contractDate || null;
          changes.push(`Contract Date: "${before.contract_date || ""}" → "${contractDate}"`);
          if (contractDate) {
            const nextDue = new Date(contractDate);
            nextDue.setMonth(nextDue.getMonth() + 6);
            fields.next_rent_notice_due = nextDue.toISOString().split("T")[0];
          } else {
            fields.next_rent_notice_due = null;
          }
        }

        if (Object.keys(fields).length > 0) {
          await update("units", unitId, fields, { typecast: true })
            .catch(async e => { throw new Error(e.message); });
          await appendUnitActivityLog(unitId, `✎ Updated by ${session.u} — ${changes.join('; ')}`, session.u, "system");
        }

        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("editUnit error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Uploading the signed contract to an existing unit — same
    // store-path-sign-at-read pattern as every other file in this
    // cutover.
    if (req.body && req.body.uploadUnitContract) {
      if (session.r === "technician") {
        return res.status(403).json({ error: "Not permitted to upload a contract." });
      }
      const { unitId, filename, contentType, fileBase64 } = req.body;
      if (!unitId || !filename || !fileBase64) {
        return res.status(400).json({ error: "unitId, filename, and fileBase64 are required" });
      }
      try {
        const { uploadFile } = await import("../lib/storageClient.js");
        const contractPath = `units/${unitId}/contract-${filename}`;
        await uploadFile(contractPath, fileBase64, contentType || "application/pdf");

        const { update } = await import("../lib/postgresClient.js");
        await update("units", unitId, { signed_contract_url: contractPath, signed_contract_filename: filename });

        await appendUnitActivityLog(unitId, `📄 Signed contract uploaded by ${session.u} — ${filename}`, session.u, "system");
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("uploadUnitContract error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Uploading the unit's SLA document — same pattern as the signed
    // contract, its own dedicated slot rather than overloading the
    // contract upload with a second, different kind of document.
    if (req.body && req.body.uploadUnitSLA) {
      if (session.r === "technician") {
        return res.status(403).json({ error: "Not permitted to upload an SLA." });
      }
      const { unitId, filename, contentType, fileBase64 } = req.body;
      if (!unitId || !filename || !fileBase64) {
        return res.status(400).json({ error: "unitId, filename, and fileBase64 are required" });
      }
      try {
        const { uploadFile } = await import("../lib/storageClient.js");
        const slaPath = `units/${unitId}/sla-${filename}`;
        await uploadFile(slaPath, fileBase64, contentType || "application/pdf");

        const { update } = await import("../lib/postgresClient.js");
        await update("units", unitId, { sla_document_url: slaPath, sla_document_filename: filename });

        await appendUnitActivityLog(unitId, `📋 SLA document uploaded by ${session.u} — ${filename}`, session.u, "system");
        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("uploadUnitSLA error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Tagging an asset to a tenant unit — same permission rule as
    // creating one. Independent of Room/Zone; a unit can span several
    // physical zones (the multi-floor semi-detached villa case).
    // unitId is optional — passed whenever the frontend already has
    // the full unit record on hand, so the event can be logged to that
    // unit's own activity ribbon; the asset tagging itself always
    // works even without it.
    if (req.body && req.body.assignAssetToUnit) {
      if (session.r === "technician") {
        return res.status(403).json({ error: "Not permitted to assign a unit." });
      }
      const { assetRecordId, unitName, unitId, assetLabel } = req.body;
      if (!assetRecordId) return res.status(400).json({ error: "assetRecordId required" });
      try {
        const { update } = await import("../lib/postgresClient.js");
        await update("components", assetRecordId, { unit: unitName || null });
        if (unitId) {
          const label = assetLabel || assetRecordId;
          await appendUnitActivityLog(unitId, unitName
            ? `🔧 Asset assigned by ${session.u} — ${label}`
            : `🔧 Asset removed by ${session.u} — ${label}`, session.u, "system");
        }
        return res.status(200).json({ success: true, unit: unitName || "" });
      } catch (err) {
        console.error("assignAssetToUnit error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // PM/staff replying in a unit's chat — same permission rule as the
    // rest of the Units tab (all except Technician). Writes to the
    // exact same Chat Log the tenant's no-login portal reads from and
    // posts to — one shared thread, not two separate ones.
    if (req.body && req.body.sendUnitChatMessage) {
      if (session.r === "technician") {
        return res.status(403).json({ error: "Not permitted to send unit messages." });
      }
      const { unitId, message, attachmentBase64, attachmentFilename, attachmentContentType } = req.body;
      if (!unitId) return res.status(400).json({ error: "unitId is required" });
      if ((!message || !message.trim()) && !attachmentBase64) {
        return res.status(400).json({ error: "A message needs text or an attachment" });
      }
      try {
        const { getById, update } = await import("../lib/postgresClient.js");

        let attachmentPath = null;
        if (attachmentBase64) {
          const { uploadFile } = await import("../lib/storageClient.js");
          attachmentPath = `units/${unitId}/chat/${Date.now()}-${attachmentFilename || "file"}`;
          await uploadFile(attachmentPath, attachmentBase64, attachmentContentType || "application/octet-stream");
        }

        const unitData = await getById("units", unitId).catch(() => { throw new Error("Could not read unit"); });

        const chatLog = Array.isArray(unitData.chat_log) ? unitData.chat_log : [];
        const entry = { from: "pm", senderName: session.u, message: (message || "").trim(), at: new Date().toISOString() };
        if (attachmentPath) { entry.attachmentPath = attachmentPath; entry.attachmentFilename = attachmentFilename || ""; entry.attachmentType = attachmentContentType || ""; }
        chatLog.push(entry);

        await update("units", unitId, { chat_log: JSON.stringify(chatLog) })
          .catch(() => { throw new Error("Could not save message"); });

        const { signChatLogAttachments } = await import("../lib/storageClient.js");
        const signedChatLog = await signChatLogAttachments(chatLog);

        return res.status(200).json({ success: true, chatLog: signedChatLog });
      } catch (err) {
        console.error("sendUnitChatMessage error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    if (req.body && req.body.addVendor) {
      const isOverseer = session.r === "business_owner" || session.r === "system_admin";
      if (!isOverseer && session.r !== "procurement") {
        return res.status(403).json({ error: "Only Procurement can add a vendor." });
      }
      const { name, email, phone, categories } = req.body;
      if (!name || !name.trim()) {
        return res.status(400).json({ error: "Vendor name is required" });
      }

      try {
        const { insert } = await import("../lib/postgresClient.js");

        const created = await insert("vendors", {
          vendor_name: name.trim(),
          email: (email || "").trim() || null,
          phone: (phone || "").trim() || null,
          categories: Array.isArray(categories) ? categories : [],
          active: true,
          added_by: session.u,
        }, { typecast: true }); // lets a new category value be added on the fly without a manual step each time

        return res.status(200).json({ success: true, vendor: {
          id: created.id,
          name: created.vendor_name || "",
          email: created.email || "",
          phone: created.phone || "",
          categories: created.categories || [],
        } });
      } catch (err) {
        console.error("addVendor error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Starting a new vendor quote against a work order — Procurement
    // only, confirmed (they're the ones sending POs and collecting
    // responses; nobody else in this flow touches vendor quotes at
    // all).
    if (req.body && req.body.addProcurementResponse) {
      const isOverseer = session.r === "business_owner" || session.r === "system_admin";
      if (!isOverseer && session.r !== "procurement") {
        return res.status(403).json({ error: "Only Procurement can add a vendor quote." });
      }
      const { woId, vendorName } = req.body;
      if (!woId || !vendorName || !vendorName.trim()) {
        return res.status(400).json({ error: "woId and vendorName are required" });
      }
      try {
        const { insert } = await import("../lib/postgresClient.js");
        const created = await insert("procurement_responses", { wo_id: woId, vendor_name: vendorName.trim(), chosen: false });
        return res.status(200).json({ success: true, responseId: created.id });
      } catch (err) {
        console.error("addProcurementResponse error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Attaching the actual proforma file to a response row already
    // created above. Uploading here also runs AI extraction on the
    // PDF — the total cost, VAT status, and a short summary — the
    // piece of the original Airtable AI field type that had no direct
    // Postgres equivalent, now rebuilt as a real Claude API call. This
    // step is deliberately non-fatal: if extraction fails for any
    // reason (a bad scan, a network hiccup, ANTHROPIC_API_KEY not set
    // yet), the file itself still saves successfully — those three
    // fields just stay whatever they already were, same graceful
    // degradation as before this was rebuilt.
    if (req.body && req.body.uploadProcurementResponseAttachment) {
      const isOverseer = session.r === "business_owner" || session.r === "system_admin";
      if (!isOverseer && session.r !== "procurement") {
        return res.status(403).json({ error: "Only Procurement can attach a vendor quote." });
      }
      const { responseId, filename, contentType, fileBase64 } = req.body;
      if (!responseId || !filename || !fileBase64) {
        return res.status(400).json({ error: "responseId, filename, and fileBase64 are required" });
      }
      try {
        const { uploadFile } = await import("../lib/storageClient.js");
        const attachmentPath = `procurement-responses/${responseId}/${filename}`;
        await uploadFile(attachmentPath, fileBase64, contentType || "application/pdf");

        const { update } = await import("../lib/postgresClient.js");
        const fields = { proforma_attachment_url: attachmentPath, proforma_attachment_filename: filename };

        let extracted = null;
        if ((contentType || "").includes("pdf") || filename.toLowerCase().endsWith(".pdf")) {
          const { extractInvoiceData } = await import("../lib/invoiceExtraction.js");
          extracted = await extractInvoiceData(fileBase64).catch(err => {
            console.error("Invoice extraction failed (non-fatal):", err.message);
            return null;
          });
        }
        if (extracted) {
          fields.total_cost_ai = extracted.totalCost;
          fields.vat_status_ai = extracted.vatStatus;
          fields.summary_ai = extracted.summary;
        }

        await update("procurement_responses", responseId, fields);

        return res.status(200).json({ success: true, extracted: !!extracted });
      } catch (err) {
        console.error("uploadProcurementResponseAttachment error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Marking the winning quote — single-select in effect: choosing one
    // un-chooses any other response already marked for the same work
    // order, so "Chosen" always means exactly one vendor, never zero or
    // several at once.
    if (req.body && req.body.chooseProcurementResponse) {
      const isOverseer = session.r === "business_owner" || session.r === "system_admin";
      if (!isOverseer && session.r !== "procurement") {
        return res.status(403).json({ error: "Only Procurement can choose a vendor quote." });
      }
      const { responseId, woId } = req.body;
      if (!responseId || !woId) return res.status(400).json({ error: "responseId and woId are required" });
      try {
        const { query: pgQuery, update } = await import("../lib/postgresClient.js");

        const listResult = await pgQuery("select * from procurement_responses where wo_id = $1", [woId])
          .catch(() => { throw new Error("Could not look up existing quotes"); });
        const others = listResult.rows.filter(r => r.id !== responseId && r.chosen);

        if (others.length > 0) {
          // This list is realistically 0-1 records (only one quote can
          // have been previously chosen), so sequential updates are
          // simple and fine here.
          for (const other of others) {
            await update("procurement_responses", other.id, { chosen: false }).catch(() => {});
          }
        }

        await update("procurement_responses", responseId, { chosen: true })
          .catch(() => { throw new Error("Could not mark quote as chosen"); });

        // Best-effort activity log on the actual work order — woId here
        // is the plain-text "WO-..." value, not the internal row id, so
        // it has to be looked up first. Not fatal if this part fails;
        // the quote is already chosen either way.
        try {
          const woResult = await pgQuery("select id from work_orders where wo_id = $1 limit 1", [woId]).catch(() => null);
          const woRecord = woResult && woResult.rows[0];
          const chosenVendor = listResult.rows.find(r => r.id === responseId);
          if (woRecord) {
            await appendActivityLog(woRecord.id, `🏆 Vendor quote chosen: ${chosenVendor ? chosenVendor.vendor_name : responseId} — by ${session.u}`, session.u, "system");
          }
        } catch (logErr) {
          console.error("chooseProcurementResponse activity log error:", logErr);
        }

        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("chooseProcurementResponse error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    // Procurement flagging a delay — a short remark that notifies
    // whoever's waiting (the routed role and the technician), so a
    // hold-up on sourcing doesn't just sit silent until someone asks.
    if (req.body && req.body.sendProcurementDelayNotice) {
      const isOverseer = session.r === "business_owner" || session.r === "system_admin";
      if (!isOverseer && session.r !== "procurement") {
        return res.status(403).json({ error: "Only Procurement can send a delay notice." });
      }
      const { recordId, message } = req.body;
      if (!recordId || !message || !message.trim()) {
        return res.status(400).json({ error: "recordId and message are required" });
      }
      try {
        const { getById } = await import("../lib/postgresClient.js");
        const current = await getById("work_orders", recordId).catch(() => ({}));

        await appendActivityLog(recordId, `⏳ Procurement delay: ${message.trim()} — ${session.u}`, session.u, "procurement_request");
        await notifyOfProcurementDelay(current.assigned_role, current.asset_name || "Unnamed", current.wo_id || "", message.trim(), current.assigned_technician);

        return res.status(200).json({ success: true });
      } catch (err) {
        console.error("sendProcurementDelayNotice error:", err);
        return res.status(500).json({ error: err.message });
      }
    }

    if (req.body && req.body.checklistToggle) {
      const { recordId, itemId, checked } = req.body;
      if (!recordId || itemId === undefined || itemId === null) return res.status(400).json({ error: "recordId and itemId required" });

      try {
        const { getById, update } = await import("../lib/postgresClient.js");

        const woData = await getById("work_orders", recordId).catch(() => { throw new Error("Could not read work order"); });

        const progress = (woData.checklist_progress && typeof woData.checklist_progress === "object") ? woData.checklist_progress : {};

        // Unchecking used to just wipe the entry — no record of who
        // unchecked it or when. Every checklist action is now recorded
        // the same way, in both directions.
        progress[itemId] = { checked: !!checked, by: session.u, at: new Date().toISOString() };

        await update("work_orders", recordId, { checklist_progress: JSON.stringify(progress) })
          .catch(() => { throw new Error("Could not save checklist progress"); });

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
        const { update } = await import("../lib/postgresClient.js");
        await update("work_orders", recordId, {
          cost_tzs: cost === "" || cost === undefined ? null : Number(cost),
          // Pulled from the verified session — same as Closed By,
          // Added By, etc. elsewhere in the system. Cannot be typed
          // in or faked by whoever's making the edit.
          cost_edited_by: session.u,
          cost_edited_date: new Date().toISOString(),
        });
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
// Same convention as appendActivityLog, scoped to the Units table
// instead — separate function since the table name/env var differs,
// not because the underlying pattern is any different.
async function appendUnitActivityLog(unitId, text, by, type) {
  const { getById, update } = await import("../lib/postgresClient.js");

  const unitData = await getById("units", unitId).catch(() => null);
  if (!unitData) { console.error("appendUnitActivityLog: could not read unit"); return null; }

  const log = Array.isArray(unitData.activity_log) ? unitData.activity_log : [];
  const entry = { type: type || "comment", text, by, at: new Date().toISOString() };
  log.push(entry);

  const ok = await update("units", unitId, { activity_log: JSON.stringify(log) }).then(() => true).catch(() => false);
  if (!ok) { console.error("appendUnitActivityLog: could not save entry"); return null; }
  return entry;
}

async function appendActivityLog(recordId, text, by, type) {
  const { getById, update } = await import("../lib/postgresClient.js");

  const woData = await getById("work_orders", recordId).catch(() => null);
  if (!woData) { console.error("appendActivityLog: could not read work order"); return null; }

  const log = Array.isArray(woData.activity_log) ? woData.activity_log : [];
  const entry = { type: type || "comment", text, by, at: new Date().toISOString() };
  log.push(entry);

  const ok = await update("work_orders", recordId, { activity_log: JSON.stringify(log) }).then(() => true).catch(() => false);
  if (!ok) { console.error("appendActivityLog: could not save entry"); return null; }
  return entry;
}

// Before/after photo upload — photoType is "before" or "after",
// mapping to the matching column. Same store-path-sign-at-read
// pattern as every other file in this cutover.
async function handleUploadWorkOrderPhoto(req, res, uploadedBy) {
  const { recordId, photoType, filename, contentType, fileBase64 } = req.body || {};
  if (!recordId || !photoType || !filename || !fileBase64) {
    return res.status(400).json({ error: "recordId, photoType, filename, and fileBase64 are required" });
  }
  if (photoType !== "before" && photoType !== "after") {
    return res.status(400).json({ error: "photoType must be 'before' or 'after'" });
  }

  const column = photoType === "before" ? "before_photo_url" : "after_photo_url";

  try {
    const { uploadFile } = await import("../lib/storageClient.js");
    const photoPath = `work-orders/${recordId}/${photoType}-${filename}`;
    await uploadFile(photoPath, fileBase64, contentType || "image/jpeg");

    const { update } = await import("../lib/postgresClient.js");
    await update("work_orders", recordId, { [column]: photoPath });

    await appendActivityLog(recordId, `📷 ${photoType === "before" ? "Before" : "After"} photo uploaded by ${uploadedBy}`, uploadedBy, "system");

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("uploadWorkOrderPhoto error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function fetchAllWorkOrders() {
  const { listAllRecords: pgListAllRecords } = await import("../lib/postgresClient.js");
  return pgListAllRecords("work_orders");
}

async function updateWorkOrder(recordId, status, notes, closedByUsername, cost) {
  const { getById, update } = await import("../lib/postgresClient.js");

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
    const checkData = await getById("work_orders", recordId).catch(() => null);
    if (checkData) {
      if (!checkData.assigned_role) {
        return {
          ok: false,
          recordId,
          error: "This work order has no routed role assigned yet — it can't be marked Ready for Review until it does.",
        };
      }
      const procStatus = checkData.procurement_status;
      if (procStatus === "Requested" || procStatus === "Rejected") {
        return {
          ok: false,
          recordId,
          error: procStatus === "Requested"
            ? "This work order can't be marked Ready for Review yet — procurement is still awaiting approval."
            : `This work order can't be marked Ready for Review yet — the procurement request was rejected (${checkData.procurement_rejection_reason || "no reason given"}) and needs to be revised.`,
        };
      }
    }
  }

  const fields = { status };
  // Never wipe existing Notes to empty through this path — a real gap
  // found on review: `notes: ""` would previously overwrite whatever
  // was there with nothing, with no role check on this path at all.
  // Legitimate notes updates still go through fine; only an explicit
  // empty-string wipe is blocked.
  if (notes !== undefined && notes !== "") fields.notes = notes;
  if (cost !== undefined) {
    fields.cost_tzs = Number(cost);
    fields.cost_edited_by = closedByUsername;
    fields.cost_edited_date = new Date().toISOString();
  }

  try {
    await update("work_orders", recordId, fields);
  } catch (e) {
    console.error(`Work order update failed for ${recordId}:`, e.message);
    return { ok: false, recordId, error: e.message };
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

  try {
    const { getById, update } = await import("../lib/postgresClient.js");

    const woData = await getById("work_orders", recordId).catch(() => { throw new Error("Could not read work order"); });

    if (woData.status !== "Ready for Review") {
      return res.status(400).json({ error: "This work order isn't waiting for review — nothing to approve." });
    }

    const assetIdForRollover = woData.asset_id;
    const reporterContact = woData.reporter_contact;
    const assetName = woData.asset_name || "the reported issue";

    await update("work_orders", recordId, {
      status: "Completed",
      completed_date: new Date().toISOString(),
      closed_by: approvedByUsername,
      closure_rejection_reason: null,
    }).catch(() => { throw new Error("Could not approve closure"); });

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

  try {
    const { update } = await import("../lib/postgresClient.js");
    await update("work_orders", recordId, { status: "In Progress", closure_rejection_reason: reason })
      .catch(() => { throw new Error("Could not reject closure"); });

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
// promptly since the job is now sitting unassigned again. Email + SMS,
// same as the original assignment notification — confirmed: both
// directions get both channels for now, can be trimmed back later
// once real usage shows whether that's more than actually needed.
async function notifyAssignerOfDecline(assignerContact, technicianUsername, reason, woId, assetName) {
  const fromName = process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager";
  if (assignerContact.email) {
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
        to: [assignerContact.email],
        subject: `Declined — ${assetName} (${woId}) needs reassignment`,
        html,
      }),
    }).catch(err => console.error("notifyAssignerOfDecline email error:", err));
  }
  if (assignerContact.phone) {
    try {
      const message = sanitizeForSmsWO(`${technicianUsername} declined ${woId} - ${assetName}: ${reason}. Please assign someone else.`);
      const auth = Buffer.from(`${process.env.BEEM_API_KEY}:${process.env.BEEM_SECRET_KEY}`).toString("base64");
      await fetch("https://apisms.beem.africa/v1/send", {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          source_addr: process.env.BEEM_SENDER_ID || "INFO",
          schedule_time: "",
          encoding: 0,
          message: message.slice(0, 300),
          recipients: [{ recipient_id: 1, dest_addr: assignerContact.phone }],
        }),
      });
    } catch (err) {
      console.error("notifyAssignerOfDecline SMS error:", err);
    }
  }
}

// Fires the moment a request is submitted — goes straight to
// Procurement now, not the engineer. No approval gate exists anymore;
// Procurement can act on this immediately.
// Reaches the routed role AND the specifically assigned technician (if
// one exists) — a delay affects both "who's waiting on this to plan
// around it" and "who's literally standing there unable to proceed."
async function notifyOfProcurementDelay(assignedRole, assetName, woId, message, assignedTechnicianUsername) {
  const routedLoginRole = ASSIGNED_ROLE_TO_LOGIN_ROLE[assignedRole];
  const directory = getAllStaffDirectory();
  const recipients = directory.filter(e => e.role === routedLoginRole || e.role === "business_owner" || e.role === "system_admin");
  if (assignedTechnicianUsername) {
    const tech = getContactForUsername(assignedTechnicianUsername);
    if (tech && !recipients.some(r => r.username === tech.username)) recipients.push(tech);
  }

  const fromName = process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager";
  const toList = recipients.map(e => e.email).filter(Boolean);
  if (toList.length > 0) {
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
        <div style="background:#B45309;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;opacity:0.85">Procurement Delay</div>
          <div style="font-size:18px;font-weight:700;margin-top:4px">${assetName} — ${woId}</div>
        </div>
        <div style="border:1px solid #E2E6ED;border-top:none;border-radius:0 0 8px 8px;padding:20px">
          <p style="margin:0;color:#1A1A2E;font-size:14px;line-height:1.6">${message}</p>
        </div>
      </div>`;
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${fromName} <${process.env.ALERT_FROM_EMAIL}>`,
        to: toList,
        subject: `Delay — ${assetName} (${woId})`,
        html,
      }),
    }).catch(err => console.error("notifyOfProcurementDelay email error:", err));
  }

  const phones = [...new Set(recipients.map(e => e.phone).filter(Boolean))];
  if (phones.length > 0) {
    try {
      const smsMessage = sanitizeForSmsWO(`Procurement delay - ${woId} ${assetName}: ${message}`);
      const auth = Buffer.from(`${process.env.BEEM_API_KEY}:${process.env.BEEM_SECRET_KEY}`).toString("base64");
      await fetch("https://apisms.beem.africa/v1/send", {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          source_addr: process.env.BEEM_SENDER_ID || "INFO",
          schedule_time: "",
          encoding: 0,
          message: smsMessage.slice(0, 300),
          recipients: phones.map((phone, i) => ({ recipient_id: i + 1, dest_addr: phone })),
        }),
      });
    } catch (err) {
      console.error("notifyOfProcurementDelay SMS error:", err);
    }
  }
}

async function notifyProcurementOfRequest(woId, assetName, requestedBy, spec) {
  const directory = getAllStaffDirectory();
  const toList = directory.filter(e => e.role === "procurement").map(e => e.email).filter(Boolean);
  if (toList.length === 0) return;

  const fromName = process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager";
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
      <div style="background:#B45309;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;opacity:0.85">Procurement Request</div>
        <div style="font-size:18px;font-weight:700;margin-top:4px">${assetName} — ${woId}</div>
      </div>
      <div style="border:1px solid #E2E6ED;border-top:none;border-radius:0 0 8px 8px;padding:20px">
        <p style="margin:0;color:#1A1A2E;font-size:14px;line-height:1.6">Requested by ${requestedBy}: <strong>${spec.description}</strong> — quantity ${spec.quantity}${spec.unit ? " " + spec.unit : ""}.</p>
      </div>
    </div>`;

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${fromName} <${process.env.ALERT_FROM_EMAIL}>`,
      to: toList,
      subject: `New procurement request — ${assetName} (${woId})`,
      html,
    }),
  }).catch(err => console.error("notifyProcurementOfRequest error:", err));
}

// Fires the moment Procurement fulfills — emails the routed role
// (Engineer, Admin, or Property Manager — whoever owns this job),
// asking them to confirm the delivery arrived correctly. This is the
// new replacement for the old approval-of-spend step — it confirms
// receipt, it doesn't authorize the purchase (that already happened).
async function notifyRoutedRoleOfDeliveryArrival(assignedRole, assetName, woId, total) {
  const routedLoginRole = ASSIGNED_ROLE_TO_LOGIN_ROLE[assignedRole];
  const directory = getAllStaffDirectory();
  const recipients = directory.filter(e => e.role === routedLoginRole || e.role === "business_owner" || e.role === "system_admin");
  const toList = recipients.map(e => e.email).filter(Boolean);

  const fromName = process.env.ALERT_FROM_NAME || "GVC Facility Asset Manager";
  if (toList.length > 0) {
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
        <div style="background:#16a34a;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.05em;text-transform:uppercase;opacity:0.85">Delivery Note — Please Confirm</div>
          <div style="font-size:18px;font-weight:700;margin-top:4px">${assetName} — ${woId}</div>
        </div>
        <div style="border:1px solid #E2E6ED;border-top:none;border-radius:0 0 8px 8px;padding:20px">
          <p style="margin:0;color:#1A1A2E;font-size:14px;line-height:1.6">TZS ${total.toLocaleString()} paid and fulfilled. Please confirm the delivery in the app once it's arrived, so the technician can proceed.</p>
        </div>
      </div>`;

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${fromName} <${process.env.ALERT_FROM_EMAIL}>`,
        to: toList,
        subject: `Confirm delivery — ${assetName} (${woId})`,
        html,
      }),
    }).catch(err => console.error("notifyRoutedRoleOfDeliveryArrival email error:", err));
  }

  const phones = [...new Set(recipients.map(e => e.phone).filter(Boolean))];
  if (phones.length > 0) {
    try {
      const message = sanitizeForSmsWO(`Delivery note - ${woId} ${assetName}: TZS ${total.toLocaleString()} paid. Confirm delivery in the app.`);
      const auth = Buffer.from(`${process.env.BEEM_API_KEY}:${process.env.BEEM_SECRET_KEY}`).toString("base64");
      await fetch("https://apisms.beem.africa/v1/send", {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          source_addr: process.env.BEEM_SENDER_ID || "INFO",
          schedule_time: "",
          encoding: 0,
          message: message.slice(0, 300),
          recipients: phones.map((phone, i) => ({ recipient_id: i + 1, dest_addr: phone })),
        }),
      });
    } catch (err) {
      console.error("notifyRoutedRoleOfDeliveryArrival SMS error:", err);
    }
  }
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
  const { getByColumn, update } = await import("../lib/postgresClient.js");

  const record = await getByColumn("components", "asset_id", assetId).catch(() => null);
  if (!record) {
    console.error("advanceAssetNextService: no Component found for", assetId);
    return;
  }

  const intervalDays = Number(record.maintenance_interval_days) || 90;
  const today = new Date();
  const nextDue = new Date(today);
  nextDue.setDate(nextDue.getDate() + intervalDays);

  await update("components", record.id, {
    last_service: today.toISOString().split("T")[0],
    next_service_due: nextDue.toISOString().split("T")[0],
  }).catch(e => console.error("advanceAssetNextService: update failed", e.message));
}

async function handleGetProcurementResponses(req, res, woId) {
  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    const { getSignedUrlSafe } = await import("../lib/storageClient.js");

    const result = await pgQuery("select * from procurement_responses where wo_id = $1", [woId])
      .catch(() => { throw new Error("Could not load vendor quotes"); });

    const responses = await Promise.all(result.rows.map(async r => {
      let attachmentUrl = null;
      try {
        attachmentUrl = await getSignedUrlSafe(r.proforma_attachment_url);
      } catch (err) {
        console.error("handleGetProcurementResponses: could not sign attachment for", r.vendor_name, err.message);
      }
      return {
        id: r.id,
        vendorName: r.vendor_name || "",
        attachmentUrl,
        attachmentFilename: r.proforma_attachment_filename || null,
        totalCost: r.total_cost_ai !== null ? Number(r.total_cost_ai) : null,
        vatStatus: r.vat_status_ai || "",
        summary: r.summary_ai || "",
        chosen: !!r.chosen,
      };
    }));
    responses.sort((a, b) => (a.totalCost ?? Infinity) - (b.totalCost ?? Infinity));

    return res.status(200).json({ responses });
  } catch (err) {
    console.error("handleGetProcurementResponses error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleGetVendors(req, res) {
  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");

    const result = await pgQuery("select * from vendors where active = true")
      .catch(() => { throw new Error("Could not load vendors"); });

    const vendors = result.rows.map(r => ({
      id: r.id,
      name: r.vendor_name || "",
      email: r.email || "",
      phone: r.phone || "",
      categories: r.categories || [],
    })).sort((a, b) => a.name.localeCompare(b.name));

    return res.status(200).json({ vendors });
  } catch (err) {
    console.error("handleGetVendors error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleMaintenanceReport(req, res) {
  const { status, from, to, asset } = req.query;
  try {
    const records = await fetchAllWorkOrders();
    let filtered = records;
    if (status) filtered = filtered.filter(r => (r.status || "") === status);
    if (asset) filtered = filtered.filter(r => (r.asset_id || "") === asset);
    if (from) { const d = new Date(from); filtered = filtered.filter(r => r.created && new Date(r.created) >= d); }
    if (to) { const d = new Date(to); d.setHours(23,59,59,999); filtered = filtered.filter(r => r.created && new Date(r.created) <= d); }
    const workOrders = await Promise.all(filtered.map(async r => {
      const { beforePhoto, afterPhoto, reporterPhoto } = await signWorkOrderPhotos(r);
      const { signChatLogAttachments } = await import("../lib/storageClient.js");
      const signedChatLog = await signChatLogAttachments(r.chat_log || []);
      return {
      woId: r.wo_id || "", assetId: r.asset_id || "",
      assetName: r.asset_name || "", system: r.system || "",
      location: r.location || "", status: r.status || "Open",
      urgency: r.urgency || "", maintenanceType: r.maintenance_type || "", created: r.created || "",
      completedDate: r.completed_date || "", closedBy: r.closed_by || "",
      cost: r.cost_tzs !== null ? Number(r.cost_tzs) : null,
      costEditedBy: r.cost_edited_by || "", costEditedDate: r.cost_edited_date || "",
      checklistProgress: JSON.stringify(r.checklist_progress || {}), activityLog: JSON.stringify(r.activity_log || []),
      chatLog: JSON.stringify(signedChatLog), chatParticipants: JSON.stringify(r.chat_participants || []),
      chatReadReceipts: JSON.stringify(r.chat_read_receipts || {}), assignedRole: r.assigned_role || "",
      assignedRoleSetBy: r.assigned_role_set_by || "", building: r.building || "", assignedTechnician: r.assigned_technician || "",
      assignedTechnicianSetBy: r.assigned_technician_set_by || "", unit: r.unit || "", nonAssetConfirmed: r.non_asset_confirmed || false,
      assetIdSetBy: r.asset_id_set_by || "", assignmentStatus: r.assignment_status || "", procurementStatus: r.procurement_status || "None",
      costBreakdown: JSON.stringify(r.cost_breakdown || []), procurementRequestedBy: r.procurement_requested_by || "",
      procurementApprovedBy: r.procurement_approved_by || "", procurementRejectionReason: r.procurement_rejection_reason || "",
      beforePhoto, afterPhoto, reporterContact: r.reporter_contact || "",
      reporterPhoto, satisfactionStatus: r.satisfaction_status || "", satisfactionReason: r.satisfaction_reason || "",
      closureRejectionReason: r.closure_rejection_reason || "",
      notes: r.notes || "",
      };
    }));
    workOrders.sort((a, b) => new Date(b.created) - new Date(a.created));

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

  try {
    const { getByColumn, insert } = await import("../lib/postgresClient.js");

    // Look up the asset so the work order has real Name/System/Location, same as other WO types
    const f = await getByColumn("components", "asset_id", assetId).catch(() => { throw new Error("Could not look up asset"); });
    if (!f) return res.status(404).json({ error: `Asset "${assetId}" not found` });

    const woId = `WO-${Date.now()}`;
    const created = await insert("work_orders", {
      wo_id: woId,
      asset_id: f.asset_id || assetId,
      asset_name: f.name || null,
      system: f.system || null,
      location: f.room_zone || null,
      status: "Open",
      urgency: "SCHEDULED",
      created: new Date().toISOString(),
      notes: notes || `Inspection scheduled by ${scheduledBy}`,
      assigned_role: getAssignedRole(f.system, f.name) || null,
      maintenance_type: "Inspection",
      activity_log: "[]",
    });

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

  try {
    const { getByColumn, insert } = await import("../lib/postgresClient.js");

    // Look up the asset so the work order has real Name/System/Location, same as every other WO type
    const f = await getByColumn("components", "asset_id", assetId).catch(() => { throw new Error("Could not look up asset"); });
    if (!f) return res.status(404).json({ error: `Asset "${assetId}" not found` });

    const woId = `WO-${Date.now()}`;
    const created = await insert("work_orders", {
      wo_id: woId,
      asset_id: f.asset_id || assetId,
      asset_name: f.name || null,
      system: f.system || null,
      location: f.room_zone || null,
      status: "Open",
      urgency: "SCHEDULED",
      created: new Date().toISOString(),
      notes: `Spare part order initiated by ${orderedBy} for ${f.name || assetId}`,
      assigned_role: getAssignedRole(f.system, f.name) || null,
      maintenance_type: "Procurement",
      activity_log: "[]",
    });

    return res.status(200).json({ success: true, woId, recordId: created.id });
  } catch (err) {
    console.error("handleOrderSparePart error:", err);
    return res.status(500).json({ error: err.message });
  }
}
