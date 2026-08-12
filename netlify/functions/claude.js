exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const clickupKey = process.env.CLICKUP_API_KEY;
  const LIST_ID = "88301430";
  const TEAM_ID = "10628585";

  try {
    const body = JSON.parse(event.body);

    if (body.action === "clickup_chat") {
      if (!clickupKey) return { statusCode: 500, body: JSON.stringify({ error: "ClickUp API key not configured" }) };

      const question = body.question;

      // Step 1: Extract acronym and period
      const extractRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6", max_tokens: 200,
          system: `Extract search parameters from a question about ClickUp tasks. Return ONLY valid JSON:
{"acronym": "TOCS", "period": "week"}
period options: "today", "week", "month", "all"`,
          messages: [{ role: "user", content: question }]
        })
      });
      const extractData = await extractRes.json();
      let params;
      try { params = JSON.parse(extractData.content[0].text.replace(/```json|```/g,"").trim()); }
      catch { return { statusCode: 200, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }, body: JSON.stringify({ answer: "No pude identificar el cliente. Incluye el acrónimo, ej: *¿Cuántas horas tiene TOCS esta semana?*" }) }; }

      const acronym = (params.acronym || "").toUpperCase();
      if (!acronym) return { statusCode: 200, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }, body: JSON.stringify({ answer: "No encontré un acrónimo. Intenta: *¿Cuántas horas lleva WPR este mes?*" }) };

      // Step 2: Calculate date range
      const now = Date.now();
      const periodMs = { today: 86400000, week: 604800000, month: 2592000000, all: null };
      const cutoff = periodMs[params.period] ? now - periodMs[params.period] : null;
      const startDate = cutoff || (now - 365 * 86400000); // default: last year
      const periodLabel = { today: "hoy", week: "esta semana", month: "este mes", all: "en total" }[params.period] || "en total";

      // Step 3: Fetch tasks to get task IDs
      let allTasks = [];
      let page = 0;
      let hasMore = true;
      while (hasMore && page < 20) {
        const res = await fetch(
          `https://api.clickup.com/api/v2/list/${LIST_ID}/task?page=${page}&archived=false&include_closed=true&subtasks=false&search_query=${encodeURIComponent(acronym)}`,
          { headers: { "Authorization": clickupKey } }
        );
        const data = await res.json();
        const tasks = data.tasks || [];
        if (tasks.length === 0) { hasMore = false; break; }
        const pattern = new RegExp(`^${acronym}\\d`, 'i');
        allTasks = allTasks.concat(tasks.filter(t => pattern.test(t.name)));
        page++;
        if (tasks.length < 100) hasMore = false;
      }

      if (allTasks.length === 0) {
        return { statusCode: 200, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
          body: JSON.stringify({ answer: `No encontré tareas para **${acronym}** en ClickUp. Verifica el acrónimo.` }) };
      }

      // Step 4: Get time entries from team endpoint filtered by date
      // This is the correct endpoint that supports date filtering
      const timeRes = await fetch(
        `https://api.clickup.com/api/v2/team/${TEAM_ID}/time_entries?start_date=${startDate}&end_date=${now}`,
        { headers: { "Authorization": clickupKey } }
      );
      const timeData = await timeRes.json();
      const allEntries = timeData.data || [];

      // Build a set of task IDs from our client
      const taskIdSet = new Set(allTasks.map(t => t.id));
      const taskNameMap = {};
      allTasks.forEach(t => { taskNameMap[t.id] = { name: t.name, status: t.status?.status || "unknown", url: t.url || `https://app.clickup.com/t/${t.id}` }; });

      // Filter entries that belong to this client's tasks
      const clientEntries = allEntries.filter(e => e.task?.id && taskIdSet.has(e.task.id));

      // Aggregate hours by task
      const taskHours = {};
      clientEntries.forEach(e => {
        const tid = e.task.id;
        if (!taskHours[tid]) taskHours[tid] = { hours: 0, name: taskNameMap[tid]?.name || e.task.name, status: taskNameMap[tid]?.status || "unknown", url: taskNameMap[tid]?.url || "" };
        taskHours[tid].hours += (parseInt(e.duration) || 0) / 3600000;
      });

      const tasksWithHours = Object.values(taskHours)
        .filter(t => t.hours > 0)
        .sort((a, b) => b.hours - a.hours)
        .map(t => ({ ...t, hours: parseFloat(t.hours.toFixed(2)) }));

      const totalHours = tasksWithHours.reduce((sum, t) => sum + t.hours, 0).toFixed(2);

      // Step 5: Claude answers
      const answerRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6", max_tokens: 400,
          system: `Eres el asistente de operaciones de Edit Crew. Responde en español, directo y claro. Usa negritas con **texto**. Máximo 3-4 líneas.`,
          messages: [{ role: "user", content: `Pregunta: "${question}"

Datos reales de ClickUp para ${acronym} (${periodLabel}):
- Total tareas del cliente: ${allTasks.length}
- Total horas registradas ${periodLabel}: ${totalHours}h
- Tareas con horas: ${tasksWithHours.length}
- Top tareas por horas: ${JSON.stringify(tasksWithHours.slice(0, 5))}

Responde la pregunta con estos datos reales.` }]
        })
      });
      const answerData = await answerRes.json();
      const answer = answerData.content?.[0]?.text || "No pude generar respuesta.";

      return {
        statusCode: 200,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        body: JSON.stringify({
          answer,
          tasks: tasksWithHours.slice(0, 5),
          debug: {
            total_tasks: allTasks.length,
            total_time_entries: allEntries.length,
            client_entries: clientEntries.length,
            tasks_with_hours: tasksWithHours.length,
            total_hours: totalHours,
            period: params.period,
            start_date: new Date(startDate).toISOString()
          }
        })
      };
    }

    // --- CLAUDE: Analyze ticket ---
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    return { statusCode: 200, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }, body: JSON.stringify(data) };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
