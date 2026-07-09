exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const clickupKey = process.env.CLICKUP_API_KEY;
  const WORKSPACE_ID = "10628585";

  try {
    const body = JSON.parse(event.body);

    // --- CLICKUP: Search tasks by acronym ---
    if (body.action === "search_tasks") {
      if (!clickupKey) return { statusCode: 500, body: JSON.stringify({ error: "ClickUp API key not configured" }) };

      const acronym = body.acronym.toUpperCase();

      // First get all spaces to find "Edit Crew"
      const spacesRes = await fetch(`https://api.clickup.com/api/v2/team/${WORKSPACE_ID}/space?archived=false`, {
        headers: { "Authorization": clickupKey }
      });
      const spacesData = await spacesRes.json();
      const editCrewSpace = spacesData.spaces?.find(s => s.name.toLowerCase().includes("edit crew"));

      if (!editCrewSpace) return { statusCode: 404, body: JSON.stringify({ error: "Space 'Edit Crew' not found" }) };

      // Get folders in space
      const foldersRes = await fetch(`https://api.clickup.com/api/v2/space/${editCrewSpace.id}/folder?archived=false`, {
        headers: { "Authorization": clickupKey }
      });
      const foldersData = await foldersRes.json();
      const projectsFolder = foldersData.folders?.find(f => f.name.toLowerCase().includes("edit crew projects"));

      if (!projectsFolder) return { statusCode: 404, body: JSON.stringify({ error: "Folder 'Edit Crew Projects' not found" }) };

      // Get lists in folder
      const listsRes = await fetch(`https://api.clickup.com/api/v2/folder/${projectsFolder.id}/list?archived=false`, {
        headers: { "Authorization": clickupKey }
      });
      const listsData = await listsRes.json();

      // Search tasks across all lists filtering by acronym
      let allTasks = [];
      for (const list of (listsData.lists || []).slice(0, 10)) {
        const tasksRes = await fetch(`https://api.clickup.com/api/v2/list/${list.id}/task?archived=false&include_closed=true&subtasks=false`, {
          headers: { "Authorization": clickupKey }
        });
        const tasksData = await tasksRes.json();
        const filtered = (tasksData.tasks || []).filter(t => t.name.toUpperCase().startsWith(acronym));
        allTasks = allTasks.concat(filtered);
      }

      // Get time tracked for each task
      const tasksWithTime = await Promise.all(allTasks.slice(0, 20).map(async task => {
        try {
          const timeRes = await fetch(`https://api.clickup.com/api/v2/task/${task.id}/time`, {
            headers: { "Authorization": clickupKey }
          });
          const timeData = await timeRes.json();
          const totalMs = (timeData.data || []).reduce((sum, entry) => sum + (entry.duration || 0), 0);
          const totalHours = (totalMs / 3600000).toFixed(1);
          return {
            id: task.id,
            name: task.name,
            status: task.status?.status || "unknown",
            hours: totalHours,
            assignees: task.assignees?.map(a => a.username).join(", ") || "—",
            due_date: task.due_date ? new Date(parseInt(task.due_date)).toLocaleDateString('en-US') : "—",
            url: task.url
          };
        } catch {
          return {
            id: task.id,
            name: task.name,
            status: task.status?.status || "unknown",
            hours: "—",
            assignees: task.assignees?.map(a => a.username).join(", ") || "—",
            due_date: task.due_date ? new Date(parseInt(task.due_date)).toLocaleDateString('en-US') : "—",
            url: task.url
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
