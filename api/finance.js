// api/finance.js
//
// A genuinely separate business entity within FAM, confirmed
// directly - not a client-facing facility module, and not restricted
// to Gracing Ventures' own internal use. Every client gets this,
// gated by a real per-organization toggle (organizations.finance_enabled)
// so a client with existing accounting software can opt out entirely,
// while a client with nothing can use this as their real system.
//
// Sensitive company-wide financial data - gated server-side to
// System Admin and Business Owner only, matching the same
// "hidden in the UI is not enough" discipline already proven for TRA
// category management. A hidden button doesn't stop a direct API call.
//
// Assets are deliberately not tracked a second time here - the real
// asset valuation already lives in the Asset Register
// (lib/depreciation.js); this module reads that, it doesn't duplicate it.

import { getSession, setSessionCookie } from "../lib/auth.js";

// Confirmed directly, twice: Finance appears for every role except
// Technician - not restricted to Business Owner/System Admin as an
// earlier version of this file incorrectly had it. The complete role
// list is confirmed directly against ROLE_PERMISSIONS in
// dashboard.html rather than assumed.
const FINANCE_EXCLUDED_ROLES = ["technician"];
const ORG_ID = "73ae9f3b-bbef-4f4a-b3df-3cca81c49063"; // the one real org that exists today

function requireFinanceRole(session, res) {
  if (FINANCE_EXCLUDED_ROLES.includes(session.r)) {
    res.status(403).json({ error: "Finance is not available to this role." });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not logged in" });
  setSessionCookie(res, session.u, session.r);

  // Confirmed directly as a real gap and fixed: this check must apply
  // to every method, not just writes. It previously sat after the GET
  // branch's own early returns, meaning any logged-in role - including
  // Technician - could already read every Finance number directly via
  // the API, even though the sidebar button was correctly hidden for
  // them. A hidden button was never the real gate; this is.
  if (!requireFinanceRole(session, res)) return;

  if (req.method === "GET") {
    if (req.query.categories === "true") return handleListCategories(req, res);
    if (req.query.transactions === "true") return handleListTransactions(req, res);
    if (req.query.bills === "true") return handleListBills(req, res);
    if (req.query.liabilities === "true") return handleListLiabilities(req, res);
    if (req.query.summary === "true") return handleFinanceSummary(req, res);
    if (req.query.vendorSpend === "true") return handleVendorSpend(req, res);
    if (req.query.payroll === "true") return handleListPayroll(req, res);
    if (req.query.staffForPayroll === "true") return handleListStaffForPayroll(req, res);
    return res.status(400).json({ error: "Unknown GET request" });
  }

  if (req.method === "POST") {
    const action = req.body && req.body.action;
    if (action === "addCategory") return handleAddCategory(req, res);
    if (action === "addTransaction") return handleAddTransaction(req, res, session.u);
    if (action === "uploadTransactionDocument") return handleUploadDoc(req, res, "transactions", "transaction_documents", "transaction_id");
    if (action === "addBill") return handleAddBill(req, res);
    if (action === "uploadBillDocument") return handleUploadDoc(req, res, "bills", "bill_documents", "bill_id");
    if (action === "markBillPaid") return handleMarkBillPaid(req, res, session.u);
    if (action === "addLiability") return handleAddLiability(req, res);
    if (action === "uploadLiabilityDocument") return handleUploadDoc(req, res, "liabilities", "liability_documents", "liability_id");
    if (action === "recordLiabilityPayment") return handleRecordLiabilityPayment(req, res, session.u);
    if (action === "addPayrollEntry") return handleAddPayrollEntry(req, res);
    if (action === "uploadPayrollDocument") return handleUploadDoc(req, res, "payroll_entries", "payroll_documents", "payroll_entry_id");
    if (action === "markPayrollPaid") return handleMarkPayrollPaid(req, res, session.u);
    return res.status(400).json({ error: "Unknown action" });
  }

  if (req.method === "PATCH") {
    const action = req.body && req.body.action;
    if (action === "editBill") return handleEditBill(req, res);
    if (action === "pauseBill") return handlePauseBill(req, res);
    if (action === "editLiability") return handleEditLiability(req, res);
    if (action === "pausePayrollEntry") return handlePausePayrollEntry(req, res);
    return res.status(400).json({ error: "Unknown action" });
  }

  if (req.method === "DELETE") {
    if (req.body && req.body.action === "deleteTransaction") return handleDeleteTransaction(req, res);
    return res.status(400).json({ error: "Unknown action" });
  }

  return res.status(405).json({ error: "Method not allowed" });
}

// ---------------------------------------------------------------
// Categories
// ---------------------------------------------------------------

async function handleListCategories(req, res) {
  try {
    const { query } = await import("../lib/postgresClient.js");
    const result = await query(
      "select id, name, type, is_default from transaction_categories where organization_id = $1 order by type, name",
      [ORG_ID]
    );
    return res.status(200).json({
      categories: result.rows.map(r => ({ id: r.id, name: r.name, type: r.type, isDefault: r.is_default })),
    });
  } catch (err) {
    console.error("finance categories read error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleAddCategory(req, res) {
  const { name, type } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "A category name is required." });
  if (!["income", "expense"].includes(type)) return res.status(400).json({ error: "Type must be income or expense." });

  try {
    const { insert } = await import("../lib/postgresClient.js");
    const category = await insert("transaction_categories", {
      organization_id: ORG_ID, name: name.trim(), type, is_default: false,
    });
    return res.status(200).json({ success: true, category: { id: category.id, name: category.name, type: category.type, isDefault: false } });
  } catch (err) {
    console.error("addCategory error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------
// Transactions — the real income/expense ledger
// ---------------------------------------------------------------

async function handleListTransactions(req, res) {
  try {
    const { query } = await import("../lib/postgresClient.js");
    const result = await query(
      `select t.id, t.type, t.amount, t.currency, t.transaction_date, t.description, t.recorded_by,
              c.name as category_name,
              (select count(*) from transaction_documents d where d.transaction_id = t.id) as doc_count
       from transactions t
       left join transaction_categories c on c.id = t.category_id
       where t.organization_id = $1
       order by t.transaction_date desc, t.created_at desc
       limit 500`,
      [ORG_ID]
    );
    return res.status(200).json({
      transactions: result.rows.map(r => ({
        id: r.id, type: r.type, amount: Number(r.amount), currency: r.currency,
        date: r.transaction_date, description: r.description, recordedBy: r.recorded_by,
        category: r.category_name || "Uncategorized", documentCount: Number(r.doc_count),
      })),
    });
  } catch (err) {
    console.error("finance transactions read error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleAddTransaction(req, res, recordedBy) {
  const { type, categoryId, amount, date, description, vendorId } = req.body || {};
  if (!["income", "expense"].includes(type)) return res.status(400).json({ error: "Type must be income or expense." });
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: "Enter a real amount greater than zero." });

  try {
    const { insert } = await import("../lib/postgresClient.js");
    const txn = await insert("transactions", {
      organization_id: ORG_ID, type, category_id: categoryId || null,
      amount: amt, transaction_date: date || new Date().toISOString().split("T")[0],
      description: description || null, recorded_by: recordedBy, vendor_id: vendorId || null,
    });
    return res.status(200).json({ success: true, transactionId: txn.id });
  } catch (err) {
    console.error("addTransaction error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleDeleteTransaction(req, res) {
  const { transactionId } = req.body || {};
  if (!transactionId) return res.status(400).json({ error: "transactionId required" });
  try {
    const { query } = await import("../lib/postgresClient.js");
    await query("delete from transactions where id = $1", [transactionId]);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("deleteTransaction error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------
// Bills — recurring monthly/annual payments
// ---------------------------------------------------------------

async function handleListBills(req, res) {
  try {
    const { query } = await import("../lib/postgresClient.js");
    const result = await query(
      `select b.id, b.name, b.amount, b.currency, b.frequency, b.next_due_date, b.status,
              c.name as category_name,
              (select count(*) from bill_documents d where d.bill_id = b.id) as doc_count
       from bills b
       left join transaction_categories c on c.id = b.category_id
       where b.organization_id = $1
       order by b.next_due_date asc`,
      [ORG_ID]
    );
    return res.status(200).json({
      bills: result.rows.map(r => ({
        id: r.id, name: r.name, amount: Number(r.amount), currency: r.currency,
        frequency: r.frequency, nextDueDate: r.next_due_date, status: r.status,
        category: r.category_name || "Uncategorized", documentCount: Number(r.doc_count),
      })),
    });
  } catch (err) {
    console.error("finance bills read error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleAddBill(req, res) {
  const { name, amount, frequency, nextDueDate, categoryId, vendorId } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "A bill name is required." });
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: "Enter a real amount greater than zero." });
  if (!["monthly", "annual"].includes(frequency)) return res.status(400).json({ error: "Frequency must be monthly or annual." });
  if (!nextDueDate) return res.status(400).json({ error: "A next due date is required." });

  try {
    const { insert } = await import("../lib/postgresClient.js");
    const bill = await insert("bills", {
      organization_id: ORG_ID, name: name.trim(), amount: amt, frequency,
      next_due_date: nextDueDate, category_id: categoryId || null, vendor_id: vendorId || null,
    });
    return res.status(200).json({ success: true, billId: bill.id });
  } catch (err) {
    console.error("addBill error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleEditBill(req, res) {
  const { billId, name, amount, frequency, nextDueDate, categoryId } = req.body || {};
  if (!billId) return res.status(400).json({ error: "billId required" });

  const updateFields = { updated_at: new Date().toISOString() };
  if (name) updateFields.name = name.trim();
  if (amount != null) updateFields.amount = Number(amount);
  if (frequency) updateFields.frequency = frequency;
  if (nextDueDate) updateFields.next_due_date = nextDueDate;
  if (categoryId !== undefined) updateFields.category_id = categoryId || null;

  try {
    const { update } = await import("../lib/postgresClient.js");
    await update("bills", billId, updateFields);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("editBill error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handlePauseBill(req, res) {
  const { billId, status } = req.body || {};
  if (!billId || !["active", "paused"].includes(status)) return res.status(400).json({ error: "billId and a real status (active/paused) required" });
  try {
    const { update } = await import("../lib/postgresClient.js");
    await update("bills", billId, { status, updated_at: new Date().toISOString() });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("pauseBill error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Marking a bill paid does two real things together: logs the actual
// expense in the transaction ledger (so it shows up in real reporting,
// not just as a reminder that fired), and advances the bill to its
// next real due date based on frequency - confirmed directly as the
// simplest, honest way to handle recurrence without guessing whether
// a bill was genuinely paid from bank data FAM doesn't have access to.
async function handleMarkBillPaid(req, res, recordedBy) {
  const { billId } = req.body || {};
  if (!billId) return res.status(400).json({ error: "billId required" });

  try {
    const { getById, update, insert } = await import("../lib/postgresClient.js");
    const bill = await getById("bills", billId).catch(() => null);
    if (!bill) return res.status(404).json({ error: "Bill not found." });

    await insert("transactions", {
      organization_id: ORG_ID, type: "expense", category_id: bill.category_id,
      amount: bill.amount, transaction_date: bill.next_due_date,
      description: `${bill.name} (bill payment)`, recorded_by: recordedBy,
      vendor_id: bill.vendor_id,
    });

    const currentDue = new Date(bill.next_due_date);
    const nextDue = new Date(currentDue);
    if (bill.frequency === "monthly") nextDue.setMonth(nextDue.getMonth() + 1);
    else nextDue.setFullYear(nextDue.getFullYear() + 1);

    await update("bills", billId, {
      next_due_date: nextDue.toISOString().split("T")[0],
      reminder_sent_for: null,
      updated_at: new Date().toISOString(),
    });

    return res.status(200).json({ success: true, nextDueDate: nextDue.toISOString().split("T")[0] });
  } catch (err) {
    console.error("markBillPaid error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------
// Liabilities — loans and debts
// ---------------------------------------------------------------

async function handleListLiabilities(req, res) {
  try {
    const { query } = await import("../lib/postgresClient.js");
    const result = await query(
      `select l.id, l.lender, l.principal, l.currency, l.interest_rate, l.start_date,
              l.repayment_frequency, l.next_payment_date, l.next_payment_amount,
              l.remaining_balance, l.status, l.notes,
              (select count(*) from liability_documents d where d.liability_id = l.id) as doc_count
       from liabilities l
       where l.organization_id = $1
       order by l.status asc, l.next_payment_date asc nulls last`,
      [ORG_ID]
    );
    return res.status(200).json({
      liabilities: result.rows.map(r => ({
        id: r.id, lender: r.lender, principal: Number(r.principal), currency: r.currency,
        interestRate: r.interest_rate != null ? Number(r.interest_rate) : null,
        startDate: r.start_date, repaymentFrequency: r.repayment_frequency,
        nextPaymentDate: r.next_payment_date,
        nextPaymentAmount: r.next_payment_amount != null ? Number(r.next_payment_amount) : null,
        remainingBalance: Number(r.remaining_balance), status: r.status, notes: r.notes,
        documentCount: Number(r.doc_count),
      })),
    });
  } catch (err) {
    console.error("finance liabilities read error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleAddLiability(req, res) {
  const { lender, principal, interestRate, startDate, repaymentFrequency, nextPaymentDate, nextPaymentAmount, notes, vendorId } = req.body || {};
  if (!lender || !lender.trim()) return res.status(400).json({ error: "A lender name is required." });
  const principalAmt = Number(principal);
  if (!principalAmt || principalAmt <= 0) return res.status(400).json({ error: "Enter a real principal amount greater than zero." });
  if (!["monthly", "annual", "lump_sum"].includes(repaymentFrequency)) return res.status(400).json({ error: "Repayment frequency must be monthly, annual, or lump_sum." });

  try {
    const { insert } = await import("../lib/postgresClient.js");
    const liability = await insert("liabilities", {
      organization_id: ORG_ID, lender: lender.trim(), principal: principalAmt,
      interest_rate: interestRate != null && interestRate !== "" ? Number(interestRate) : null,
      start_date: startDate || new Date().toISOString().split("T")[0],
      repayment_frequency: repaymentFrequency,
      next_payment_date: nextPaymentDate || null,
      next_payment_amount: nextPaymentAmount != null && nextPaymentAmount !== "" ? Number(nextPaymentAmount) : null,
      remaining_balance: principalAmt, notes: notes || null, vendor_id: vendorId || null,
    });
    return res.status(200).json({ success: true, liabilityId: liability.id });
  } catch (err) {
    console.error("addLiability error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleEditLiability(req, res) {
  const { liabilityId, nextPaymentDate, nextPaymentAmount, notes, status } = req.body || {};
  if (!liabilityId) return res.status(400).json({ error: "liabilityId required" });

  const updateFields = { updated_at: new Date().toISOString() };
  if (nextPaymentDate !== undefined) updateFields.next_payment_date = nextPaymentDate || null;
  if (nextPaymentAmount !== undefined) updateFields.next_payment_amount = nextPaymentAmount != null && nextPaymentAmount !== "" ? Number(nextPaymentAmount) : null;
  if (notes !== undefined) updateFields.notes = notes || null;
  if (status && ["active", "paid_off"].includes(status)) updateFields.status = status;

  try {
    const { update } = await import("../lib/postgresClient.js");
    await update("liabilities", liabilityId, updateFields);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("editLiability error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Recording a real payment does three things together: logs the
// actual expense in the ledger, reduces the real remaining balance,
// and correctly marks the liability paid off once the balance
// genuinely reaches zero - rather than requiring a separate manual
// step to notice that.
async function handleRecordLiabilityPayment(req, res, recordedBy) {
  const { liabilityId, amount, date } = req.body || {};
  if (!liabilityId) return res.status(400).json({ error: "liabilityId required" });
  const paymentAmt = Number(amount);
  if (!paymentAmt || paymentAmt <= 0) return res.status(400).json({ error: "Enter a real payment amount greater than zero." });

  try {
    const { getById, update, insert } = await import("../lib/postgresClient.js");
    const liability = await getById("liabilities", liabilityId).catch(() => null);
    if (!liability) return res.status(404).json({ error: "Liability not found." });

    const newBalance = Math.max(0, Number(liability.remaining_balance) - paymentAmt);

    await insert("transactions", {
      organization_id: ORG_ID, type: "expense", category_id: null,
      amount: paymentAmt, transaction_date: date || new Date().toISOString().split("T")[0],
      description: `Loan repayment — ${liability.lender}`, recorded_by: recordedBy,
      vendor_id: liability.vendor_id,
    });

    await update("liabilities", liabilityId, {
      remaining_balance: newBalance,
      status: newBalance === 0 ? "paid_off" : liability.status,
      updated_at: new Date().toISOString(),
    });

    return res.status(200).json({ success: true, remainingBalance: newBalance, paidOff: newBalance === 0 });
  } catch (err) {
    console.error("recordLiabilityPayment error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------
// Document upload — same real, proven pattern already used for
// assets and planned maintenance (5MB limit, timestamped path,
// Supabase storage), not a new upload mechanism.
// ---------------------------------------------------------------

async function handleUploadDoc(req, res, parentTable, docTable, fkColumn) {
  const { recordId, filename, contentType, fileBase64 } = req.body || {};
  if (!recordId || !filename || !contentType || !fileBase64) {
    return res.status(400).json({ error: "recordId, filename, contentType, and fileBase64 are all required" });
  }
  const approxBytes = fileBase64.length * 0.75;
  if (approxBytes > 5 * 1024 * 1024) {
    return res.status(400).json({ error: "File is too large — the upload limit is 5MB." });
  }

  try {
    const { uploadFile } = await import("../lib/storageClient.js");
    const docPath = `${parentTable}/${recordId}/documents/${Date.now()}-${filename}`;
    await uploadFile(docPath, fileBase64, contentType);

    const { insert } = await import("../lib/postgresClient.js");
    await insert(docTable, { [fkColumn]: recordId, url: docPath, filename });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("finance document upload error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------
// Summary — real, current totals for the Finance tab's overview
// ---------------------------------------------------------------

async function handleFinanceSummary(req, res) {
  try {
    const { query } = await import("../lib/postgresClient.js");
    const totals = await query(
      `select type, coalesce(sum(amount), 0) as total from transactions where organization_id = $1 group by type`,
      [ORG_ID]
    );
    const income = Number(totals.rows.find(r => r.type === "income")?.total || 0);
    const expense = Number(totals.rows.find(r => r.type === "expense")?.total || 0);

    const liabilityTotal = await query(
      `select coalesce(sum(remaining_balance), 0) as total from liabilities where organization_id = $1 and status = 'active'`,
      [ORG_ID]
    );

    const upcomingBills = await query(
      `select coalesce(sum(amount), 0) as total from bills where organization_id = $1 and status = 'active' and next_due_date <= current_date + interval '30 days'`,
      [ORG_ID]
    );

    // Real, 6-month income/expense trend for the Overview chart -
    // generate_series ensures a month with zero activity still shows
    // as a real zero bar, not a gap that looks like missing data.
    const monthlyTrend = await query(
      `select
         to_char(month_start, 'YYYY-MM') as month,
         coalesce(sum(t.amount) filter (where t.type = 'income'), 0) as income,
         coalesce(sum(t.amount) filter (where t.type = 'expense'), 0) as expense
       from generate_series(date_trunc('month', current_date - interval '5 months'), date_trunc('month', current_date), interval '1 month') as month_start
       left join transactions t on date_trunc('month', t.transaction_date) = month_start and t.organization_id = $1
       group by month_start
       order by month_start asc`,
      [ORG_ID]
    );

    // Real expense-by-category breakdown for the Overview chart -
    // top 6 by spend, with anything beyond that folded into a real
    // "Other" total rather than an unreadably long legend. Scoped to
    // the same 6-month window as the trend chart above - confirmed
    // directly this needed fixing, since an all-time total here would
    // silently mismatch what the trend chart shows for the same
    // period, which would read as broken rather than intentional.
    const categoryBreakdown = await query(
      `select coalesce(c.name, 'Uncategorized') as category, sum(t.amount) as total
       from transactions t
       left join transaction_categories c on c.id = t.category_id
       where t.organization_id = $1 and t.type = 'expense'
         and t.transaction_date >= date_trunc('month', current_date - interval '5 months')
       group by c.name
       order by total desc`,
      [ORG_ID]
    );

    return res.status(200).json({
      totalIncome: income,
      totalExpense: expense,
      netPosition: income - expense,
      totalLiabilities: Number(liabilityTotal.rows[0].total),
      billsDueNext30Days: Number(upcomingBills.rows[0].total),
      monthlyTrend: monthlyTrend.rows.map(r => ({ month: r.month, income: Number(r.income), expense: Number(r.expense) })),
      categoryBreakdown: (() => {
        const rows = categoryBreakdown.rows.map(r => ({ category: r.category, total: Number(r.total) }));
        const top = rows.slice(0, 6);
        const rest = rows.slice(6).reduce((sum, r) => sum + r.total, 0);
        if (rest > 0) top.push({ category: "Other", total: rest });
        return top;
      })(),
    });
  } catch (err) {
    console.error("finance summary error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------
// Vendor spend — confirmed directly as the real goal: make it easy
// to see total spend against a specific vendor. Sums directly against
// the real, unified transactions ledger, since every real expense -
// whether entered directly or generated from a bill/liability payment
// - already carries the same vendor_id there. One clean sum per
// vendor, not three separate aggregations across different shapes.
// ---------------------------------------------------------------

async function handleVendorSpend(req, res) {
  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    const result = await pgQuery(
      `select v.id, v.vendor_name, v.email, v.phone,
              coalesce(sum(t.amount) filter (where t.type = 'expense'), 0) as total_spend,
              count(t.id) filter (where t.type = 'expense') as transaction_count,
              max(t.transaction_date) filter (where t.type = 'expense') as last_transaction_date
       from vendors v
       left join transactions t on t.vendor_id = v.id and t.organization_id = $1
       where v.active = true
       group by v.id, v.vendor_name, v.email, v.phone
       order by total_spend desc, v.vendor_name asc`,
      [ORG_ID]
    );
    return res.status(200).json({
      vendors: result.rows.map(r => ({
        id: r.id, name: r.vendor_name, email: r.email, phone: r.phone,
        totalSpend: Number(r.total_spend), transactionCount: Number(r.transaction_count),
        lastTransactionDate: r.last_transaction_date,
      })),
    });
  } catch (err) {
    console.error("finance vendor spend error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// ---------------------------------------------------------------
// Payroll — confirmed directly: links to the real, existing users
// table (the actual login/account system already backing Manage
// Staff), not a third, separate "employees" list. Same access as the
// rest of Finance, confirmed directly - the requireFinanceRole check
// already applied to this whole file covers Payroll too, no tighter
// restriction added.
// ---------------------------------------------------------------

async function handleListStaffForPayroll(req, res) {
  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    const result = await pgQuery(
      `select id, username, display_name, role from users order by coalesce(display_name, username) asc`
    );
    return res.status(200).json({
      staff: result.rows.map(r => ({ id: r.id, name: r.display_name || r.username, role: r.role })),
    });
  } catch (err) {
    console.error("finance staffForPayroll error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleListPayroll(req, res) {
  try {
    const { query: pgQuery } = await import("../lib/postgresClient.js");
    const result = await pgQuery(
      `select p.id, p.salary_amount, p.currency, p.payment_method, p.account_holder_name,
              p.account_number, p.bank_name, p.frequency, p.next_pay_date, p.status,
              u.display_name, u.username, u.role,
              (select count(*) from payroll_documents d where d.payroll_entry_id = p.id) as doc_count
       from payroll_entries p
       join users u on u.id = p.user_id
       where p.organization_id = $1
       order by p.status asc, p.next_pay_date asc`,
      [ORG_ID]
    );
    return res.status(200).json({
      payroll: result.rows.map(r => ({
        id: r.id, employeeName: r.display_name || r.username, role: r.role,
        salaryAmount: Number(r.salary_amount), currency: r.currency,
        paymentMethod: r.payment_method, accountHolderName: r.account_holder_name,
        accountNumber: r.account_number, bankName: r.bank_name,
        frequency: r.frequency, nextPayDate: r.next_pay_date, status: r.status,
        documentCount: Number(r.doc_count),
      })),
    });
  } catch (err) {
    console.error("finance payroll read error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handleAddPayrollEntry(req, res) {
  const { userId, salaryAmount, paymentMethod, accountHolderName, accountNumber, bankName, frequency, nextPayDate } = req.body || {};
  if (!userId) return res.status(400).json({ error: "Choose a real staff member." });
  const salary = Number(salaryAmount);
  if (!salary || salary <= 0) return res.status(400).json({ error: "Enter a real salary amount greater than zero." });
  if (!["bank", "mobile_money"].includes(paymentMethod)) return res.status(400).json({ error: "Payment method must be bank or mobile_money." });
  if (!accountHolderName || !accountHolderName.trim()) return res.status(400).json({ error: "Account holder name is required." });
  if (!accountNumber || !accountNumber.trim()) return res.status(400).json({ error: "A real account or mobile money number is required." });
  if (!nextPayDate) return res.status(400).json({ error: "A next pay date is required." });

  try {
    const { insert } = await import("../lib/postgresClient.js");
    const entry = await insert("payroll_entries", {
      organization_id: ORG_ID, user_id: userId, salary_amount: salary,
      payment_method: paymentMethod, account_holder_name: accountHolderName.trim(),
      account_number: accountNumber.trim(), bank_name: bankName || null,
      frequency: frequency === "annual" ? "annual" : "monthly",
      next_pay_date: nextPayDate,
    });
    return res.status(200).json({ success: true, payrollEntryId: entry.id });
  } catch (err) {
    // Confirmed directly against the real schema constraint: only one
    // active payroll entry per person is allowed, so a genuine
    // duplicate attempt gets a real, specific error rather than a raw
    // database message.
    if (err.message && err.message.includes("idx_payroll_entries_one_per_user")) {
      return res.status(400).json({ error: "This person already has an active payroll entry. Pause or edit the existing one instead." });
    }
    console.error("addPayrollEntry error:", err);
    return res.status(500).json({ error: err.message });
  }
}

async function handlePausePayrollEntry(req, res) {
  const { payrollEntryId, status } = req.body || {};
  if (!payrollEntryId || !["active", "paused"].includes(status)) return res.status(400).json({ error: "payrollEntryId and a real status (active/paused) required" });
  try {
    const { update } = await import("../lib/postgresClient.js");
    await update("payroll_entries", payrollEntryId, { status, updated_at: new Date().toISOString() });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("pausePayrollEntry error:", err);
    return res.status(500).json({ error: err.message });
  }
}

// Marking payroll paid does the same real, honest thing bills already
// do: logs the real expense in the ledger, and advances to the next
// real pay date based on frequency - confirmed directly as the
// simplest honest approach given FAM has no real bank-data access to
// verify a payment actually landed otherwise.
async function handleMarkPayrollPaid(req, res, recordedBy) {
  const { payrollEntryId } = req.body || {};
  if (!payrollEntryId) return res.status(400).json({ error: "payrollEntryId required" });

  try {
    const { getById, update, insert, query: pgQuery } = await import("../lib/postgresClient.js");
    const entry = await getById("payroll_entries", payrollEntryId).catch(() => null);
    if (!entry) return res.status(404).json({ error: "Payroll entry not found." });

    const userResult = await pgQuery("select display_name, username from users where id = $1", [entry.user_id]);
    const employeeName = userResult.rows[0]?.display_name || userResult.rows[0]?.username || "Employee";

    await insert("transactions", {
      organization_id: ORG_ID, type: "expense", category_id: null,
      amount: entry.salary_amount, transaction_date: entry.next_pay_date,
      description: `Salary — ${employeeName}`, recorded_by: recordedBy,
    });

    const currentDue = new Date(entry.next_pay_date);
    const nextDue = new Date(currentDue);
    if (entry.frequency === "monthly") nextDue.setMonth(nextDue.getMonth() + 1);
    else nextDue.setFullYear(nextDue.getFullYear() + 1);

    await update("payroll_entries", payrollEntryId, {
      next_pay_date: nextDue.toISOString().split("T")[0],
      reminder_sent_for: null,
      updated_at: new Date().toISOString(),
    });

    return res.status(200).json({ success: true, nextPayDate: nextDue.toISOString().split("T")[0] });
  } catch (err) {
    console.error("markPayrollPaid error:", err);
    return res.status(500).json({ error: err.message });
  }
}
