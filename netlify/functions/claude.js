exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const clickupKey = process.env.CLICKUP_API_KEY;
  const LIST_ID = "88301430";

  try {
    const body = JSON.parse(event.body);

    // --- CLICKUP: Search tasks by acronym ---
    if (body.action === "search_tasks") {
      if (!clickupKey) return { statusCode: 500, body: JSON.stringify({ error: "ClickUp API key not configured" }) };

      const acronym = body.acronym.toUpperCase();
      let allTasks = [];
      let page = 0;
      let hasMore = true;

      // Paginate through all tasks in the list
      while (hasMore && page < 5) {
        const res = await fetch(`https://api.clickup.com/api/v2/list/${LIST_ID}/task?page=${page}&archived=false&include_closed=true&subtasks=false`, {
          headers: { "Authorization": clickupKey }
        });
        const data = await res.json();

        if (!res.ok) {
          return {
            statusCode: res.status,
            body: JSON.stringify({ error: data.err || "ClickUp error", detail: data })
          };
        }

        const tasks = data.tasks || [];
        if (tasks.length === 0) { hasMore = false; break; }

        const filtered = tasks.filter(t => t.name.toUpperCase().startsWith(acronym));
        allTasks = allTasks.concat(filtered);
        page++;

        if (tasks.length < 100) hasMore = false;
      }

      // Get time tracked for each task
      const tasksWithTime = await Promise.all(allTasks.slice(0, 20).map(async task => {
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
            url: task.url || `https://app.clickup.com/t/${task.id}`
          };
        } catch {
          return {
            id: task.id,
            name: task.name,
            status: task.status?.status || "unknown",
            hours: "—",
            assignees: (task.assignees || []).map(a => a.username || a.email).join(", ") || "—",
            due_date: task.due_date ? new Date(parseInt(task.due_date)).toLocaleDateString('en-US') : "—",
            url: task.url || `https://app.clickup.com/t/${task.id}`
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
