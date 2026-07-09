exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const clickupKey = process.env.CLICKUP_API_KEY;
  const LIST_ID = "88301430";

  try {
    const body = JSON.parse(event.body);

    // --- CLICKUP CHAT: Natural language query ---
    if (body.action === "clickup_chat") {
      if (!clickupKey) return { statusCode: 500, body: JSON.stringify({ error: "ClickUp API key not configured" }) };

      const question = body.question;

      // Step 1: Ask Claude what acronym and filters to extract from the question
      const extractRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 200,
          system: `Extract search parameters from a question about ClickUp tasks. Return ONLY a JSON object like:
{"acronym": "TOCS", "period": "week", "status": null, "task_name": null}

period options: "today", "week", "month", "all" (default "all")
status: exact status name if mentioned, otherwise null
task_name: specific task name/number if mentioned, otherwise null
acronym: the client acronym in uppercase, required`,
          messages: [{ role: "user", content: question }]
        })
      });
      const extractData = await extractRes.json();
      let params;
      try {
        params = JSON.parse(extractData.content[0].text.replace(/```json|```/g, "").trim());
      } catch {
        return { statusCode: 200, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
          body: JSON.stringify({ answer: "No pude identificar el cliente en tu pregunta. ¿Puedes incluir el acrónimo? Ejemplo: *¿Cuántas horas tiene TOCS esta semana?*" }) };
      }

      if (!params.acronym) {
        return { statusCode: 200, headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
          body: JSON.stringify({ answer: "No encontré un acrónimo de cliente en tu pregunta. Intenta algo como: *¿Cuántas horas lleva WPR este mes?*" }) };
      }

      // Step 2: Fetch tasks from ClickUp filtered by acronym
      const acronym = params.acronym.toUpperCase();
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

      // Step 3: Get time entries with date filtering
      const now = Date.now();
      const periodMs = {
        today: 24 * 60 * 60 * 1000,
        week: 7 * 24 * 60 * 60 * 1000,
        month: 30 * 24 * 60 * 60 * 1000,
        all: null
      };
      const cutoff = periodMs[params.period] ? now - periodMs[params.period] : null;

      const tasksWithData = await Promise.all(allTasks.slice(0, 50).map(async task => {
        try {
          const timeRes = await fetch(`https://api.clickup.com/api/v2/task/${task.id}/time`, {
            headers: { "Authorization": clickupKey }
          });
          const timeData = await timeRes.json();
          const entries = timeData.data || [];
          const filteredEntries = cutoff
            ? entries.filter(e => parseInt(e.start) >= cutoff)
            : entries;
          const totalMs = filteredEntries.reduce((sum, e) => sum + (parseInt(e.duration) || 0), 0);
          return {
            name: task.name,
            status: task.status?.status || "unknown",
            hours: (totalMs / 3600000).toFixed(2),
            assignees: (task.assignees || []).map(a => a.username || a.email).join(", ") || "—",
            due_date: task.due_date ? new Date(parseInt(task.due_date)).toLocaleDateString('en-US') : "—",
            url: task.url || `https://app.clickup.com/t/${task.id}`
          };
        } catch {
          return { name: task.name, status: task.status?.status || "unknown", hours: "0.00", assignees: "—", due_date: "—", url: "" };
        }
      }));

      // Step 4: Ask Claude to answer the question with real data
      const dataContext = JSON.stringify(tasksWithData, null, 2);
      const answerRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 400,
          system: `Eres el asistente de operaciones de Edit Crew, una agencia de edición de video. Tienes acceso a datos reales de ClickUp.
Responde en español, de forma clara y directa. Usa números concretos. Si hay tareas relevantes, menciona sus nombres.
Período consultado: ${params.period === 'week' ? 'esta semana' : params.period === 'month' ? 'este mes' : params.period === 'today' ? 'hoy' : 'total histórico'}.
Formato: respuesta concisa en 2-4 líneas máximo. Puedes usar negritas con **texto**.`,
          messages: [{
            role: "user",
            content: `Pregunta del PM: "${question}"\n\nDatos de ClickUp para el cliente ${acronym}:\n${dataContext}\n\nResponde la pregunta con estos datos reales.`
          }]
        })
      });

      const answerData = await answerRes.json();
      const answer = answerData.content?.[0]?.text || "No pude generar una respuesta.";

      // Include relevant task links if few results
      const relevantTasks = tasksWithData.filter(t => parseFloat(t.hours) > 0).slice(0, 5);

      return {
        statusCode: 200,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        body: JSON.stringify({ answer, tasks: relevantTasks, acronym, period: params.period })
      };
    }

    // --- CLAUDE: Analyze ticket ---
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
      body: JSON.stringify(data)
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
