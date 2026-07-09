exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const clickupKey = process.env.CLICKUP_API_KEY;
  const TEAM_ID = "10628585";

  try {
    const body = JSON.parse(event.body);

    // --- CLICKUP: Search tasks by acronym ---
    if (body.action === "search_tasks") {
      if (!clickupKey) return { statusCode: 500, body: JSON.stringify({ error: "ClickUp API key not configured" }) };

      const acronym = body.acronym.toUpperCase();

      // Use ClickUp search endpoint directly
      const searchRes = await fetch(`https://api.clickup.com/api/v2/team/${TEAM_ID}/task?page=0&order_by=updated&reverse=true&subtasks=false&include_closed=true&search_query=${encodeURIComponent(acronym)}`, {
        headers: { "Authorization": clickupKey, "Content-Type": "application/json" }
      });

      const searchData = await searchRes.json();

      if (!searchRes.ok) {
        return {
          statusCode: searchRes.status,
          body: JSON.stringify({ error: searchData.err || searchData.error || "ClickUp error", detail: searchData })
        };
      }

      // Filter tasks that start with the acronym
      const tasks = (searchData.tasks || []).filter(t =>
        t.name.toUpperCase().startsWith(acronym)
      );

      // Get time tracked for each task
      const tasksWithTime = await Promise.all(tasks.slice(0, 20).map(async task => {
        try {
          const timeRes = await fetch(`https://api.clickup.com/api/v2/task/${task.id}/time`, {
            headers: { "Authorization": clickupKey }
          });
          const timeData = await timeRes.json();
          const totalMs = (timeData.data || []).reduce((sum, e) => sum + (parseInt(e.duration) || 0), 0);
          const totalHours = (totalMs / 3600000).toFixed(1);
          return {
            id: task.id,
            name: task.name,
            status: task.status?.status || "unknown",
            hours: totalHours,
            assignees: (task.assignees || []).map(a => a.username || a.email).join(", ") || "—",
            due_date: task.due_date ? new Date(parseInt(task.due_date)).toLocaleDateString('en-US') : "—",
            url: `https://app.clickup.com/t/${TEAM_ID}/${task.id}`
          };
        } catch {
          return {
            id: task.id,
            name: task.name,
            status: task.status?.status || "unknown",
            hours: "—",
            assignees: (task.assignees || []).map(a => a.username || a.email).join(", ") || "—",
            due_date: task.due_date ? new Date(parseInt(task.due_date)).toLocaleDateString('en-US') : "—",
            url: `https://app.clickup.com/t/${TEAM_ID}/${task.id}`
          };
        }
      }));

      return {
        statusCode: 200,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        body: JSON.stringify({ tasks: tasksWithTime, total: tasksWithTime.length })
      };
    }

    // --- CLAUDE: Analyze ticket ---
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
      body: JSON.stringify(data)
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
