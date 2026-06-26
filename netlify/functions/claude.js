exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const clickupKey = process.env.CLICKUP_API_KEY;

  if (!anthropicKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "Anthropic API key not configured" }) };
  }

  try {
    const body = JSON.parse(event.body);

    // If requesting ClickUp docs
    if (body.action === "get_clickup_docs") {
      if (!clickupKey) {
        return { statusCode: 500, body: JSON.stringify({ error: "ClickUp API key not configured" }) };
      }

      // Get all docs from workspace
      const workspaceId = "10628585";
      const docsRes = await fetch(`https://api.clickup.com/api/v2/team/${workspaceId}/view`, {
        headers: { "Authorization": clickupKey }
      });

      // Search for docs in the workspace
      const searchRes = await fetch(`https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs?deleted=false&limit=50`, {
        headers: { "Authorization": clickupKey, "Content-Type": "application/json" }
      });

      const searchData = await searchRes.json();
      return {
        statusCode: 200,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        body: JSON.stringify(searchData)
      };
    }

    // If fetching specific doc content
    if (body.action === "get_doc_content") {
      if (!clickupKey) {
        return { statusCode: 500, body: JSON.stringify({ error: "ClickUp API key not configured" }) };
      }
      const workspaceId = "10628585";
      const docRes = await fetch(`https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs/${body.doc_id}/pages`, {
        headers: { "Authorization": clickupKey }
      });
      const docData = await docRes.json();
      return {
        statusCode: 200,
        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
        body: JSON.stringify(docData)
      };
    }

    // Default: Claude API call
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
