// routes/dashboard.js — mounted at /api/teams/:teamId/dashboard
const express = require("express");
const { pool } = require("../db/pool");
const { requireAuth, requireTeamMember } = require("../middleware/auth");
const { enrichTask } = require("../lib/taskStatus");
const { computeDashboardStats } = require("../lib/dashboardStats");

const router = express.Router({ mergeParams: true });
router.use(requireAuth, requireTeamMember);

router.get("/", async (req, res, next) => {
  try {
    const { teamId } = req.params;
    const { month } = req.query;

    const { rows: taskRows } = await pool.query(
      `SELECT t.*, u.full_name AS assignee_name
       FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.team_id = $1`,
      [teamId]
    );
    let tasks = taskRows.map(enrichTask);

    if (month && month !== "all" && /^\d{4}-\d{2}$/.test(month)) {
      tasks = tasks.filter((t) => {
        const dMonth = t.deadline ? String(t.deadline).slice(0, 7) : null;
        const sMonth = t.startDate ? String(t.startDate).slice(0, 7) : null;
        const cMonth = t.createdAt ? String(t.createdAt).slice(0, 7) : null;
        if (dMonth === month || sMonth === month || cMonth === month) return true;
        if (t.effectiveStatus !== "complete") {
          const earliest = sMonth || cMonth || dMonth;
          if (earliest && earliest <= month && (!dMonth || dMonth >= month)) return true;
        }
        return false;
      });
    }

    const { rows: members } = await pool.query(
      `SELECT u.id, u.full_name, tm.role
       FROM team_members tm JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = $1`,
      [teamId]
    );

    const { rows: recent } = await pool.query(
      `SELECT t.id, t.title, t.status, t.updated_at, u.full_name AS assignee_name
       FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.team_id = $1 ORDER BY t.updated_at DESC LIMIT 6`,
      [teamId]
    );

    res.json({
      ...computeDashboardStats(tasks, members),
      recentActivity: recent,
      period: month || "all",
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
