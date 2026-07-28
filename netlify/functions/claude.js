exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const clickupKey = process.env.CLICKUP_API_KEY;
  const LIST_ID = "88301430";

  try {
    const body = JSON.parse(event.body);

    if (body.action === "clickup_chat") {
      if (!clickupKey) return { statusCode: 500, body: JSON.stringify({ error: "ClickUp API key not configured" }) };

      const question = body.question;

      // Step 1: Extract acronym and period from question
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
      if (!acronym) return { statusCode: 200, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" }, body: JSON.stringify({ answer: "No encontré un acrónimo de cliente. Intenta: *¿Cuántas horas lleva WPR este mes?*" }) };

      // Step 2: Fetch tasks
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
          body: JSON.stringify({ answer: `No encontré tareas para el cliente **${acronym}** en ClickUp. Verifica que el acrónimo sea correcto.` }) };
      }

      // Step 3: Get time using /v2/team time entries endpoint (more reliable)
      const now = Date.now();
      const periodMs = { today: 86400000, week: 604800000, month: 2592000000, all: null };
      const cutoff = periodMs[params.period] ? now - periodMs[params.period] : null;

      // Try getting time entries per task
      const tasksWithData = await Promise.all(allTasks.slice(0, 30).map(async task => {
        try {
          // Use the time entries endpoint with date filter if applicable
          let timeUrl = `https://api.clickup.com/api/v2/task/${task.id}/time`;
          if (cutoff) timeUrl += `?start_date=${cutoff}&end_date=${now}`;

          const timeRes = await fetch(timeUrl, { headers: { "Authorization": clickupKey } });
          const timeData = await timeRes.json();
          const entries = timeData.data || [];
          const totalMs = entries.reduce((sum, e) => sum + (parseInt(e.duration) || 0), 0);

          return {
            name: task.name,
            status: task.status?.status || "unknown",
            hours: parseFloat((totalMs / 3600000).toFixed(2)),
            assignees: (task.assignees || []).map(a => a.username || a.email).join(", ") || "—",
            due_date: task.due_date ? new Date(parseInt(task.due_date)).toLocaleDateString('en-US') : "—",
            url: task.url || `https://app.clickup.com/t/${task.id}`,
            entries_count: entries.length
          };
        } catch(e) {
          return { name: task.name, status: task.status?.status||"unknown", hours: 0, assignees:"—", due_date:"—", url:"", entries_count: 0 };
        }
      }));

      const totalHours = tasksWithData.reduce((sum, t) => sum + t.hours, 0).toFixed(2);
      const tasksWithHours = tasksWithData.filter(t => t.hours > 0);
      const periodLabel = { today: "hoy", week: "esta semana", month: "este mes", all: "en total" }[params.period] || "en total";

      // Step 4: Claude answers with real data
      const answerRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6", max_tokens: 400,
          system: `Eres el asistente de operaciones de Edit Crew. Responde en español, directo y claro. Usa negritas con **texto**. Máximo 3-4 líneas.`,
          messages: [{ role: "user", content: `Pregunta: "${question}"

Datos reales de ClickUp para ${acronym} (${periodLabel}):
- Total tareas encontradas: ${allTasks.length}
- Tareas con horas registradas: ${tasksWithHours.length}
- Total horas ${periodLabel}: ${totalHours}h
- Detalle por tarea: ${JSON.stringify(tasksWithData.slice(0, 10))}

Responde la pregunta con estos datos.` }]
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
            total_tasks_found: allTasks.length,
            tasks_with_hours: tasksWithHours.length,
            total_hours: totalHours,
            period: params.period,
            cutoff_used: cutoff ? new Date(cutoff).toISOString() : "none",
            sample_entries: tasksWithData.slice(0, 3).map(t => ({ name: t.name, hours: t.hours, entries: t.entries_count }))
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
