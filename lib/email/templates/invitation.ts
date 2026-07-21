function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function getInvitationEmailTemplate(params: {
  inviterName: string;
  organizationName: string;
  roleName: string;
  joinLink: string;
}) {
  const inviterName = escapeHtml(params.inviterName);
  const organizationName = escapeHtml(params.organizationName);
  const roleName = escapeHtml(params.roleName);
  const joinLink = escapeHtml(params.joinLink);

  return `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Invitación a Uellix</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #0F172A;
      background-color: #F8FAFC;
      margin: 0;
      padding: 0;
    }
    .container {
      max-width: 600px;
      margin: 40px auto;
      background-color: #FFFFFF;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    }
    .header {
      background-color: #0F172A;
      padding: 32px 40px;
      text-align: center;
    }
    .header h1 {
      color: #FFFFFF;
      margin: 0;
      font-size: 24px;
      font-weight: 600;
      letter-spacing: -0.025em;
    }
    .content {
      padding: 40px;
    }
    .greeting {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 24px;
      color: #0F172A;
    }
    .message {
      font-size: 16px;
      color: #475569;
      margin-bottom: 32px;
    }
    .button-container {
      text-align: center;
      margin-bottom: 32px;
    }
    .button {
      display: inline-block;
      background-color: #FF6A00;
      color: #FFFFFF;
      text-decoration: none;
      padding: 14px 28px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 16px;
    }
    .footer {
      background-color: #F8FAFC;
      padding: 24px 40px;
      text-align: center;
      font-size: 14px;
      color: #64748B;
      border-top: 1px solid #E2E8F0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Uellix</h1>
    </div>
    <div class="content">
      <div class="greeting">Has sido invitado a unirte a un equipo en Uellix.</div>
      <div class="message">
        Hola,<br><br>
        <strong>${inviterName}</strong> te ha invitado a formar parte de <strong>${organizationName}</strong> en Uellix con el rol de <strong>${roleName}</strong>.<br><br>
        Uellix es el ledger cívico de impacto que transforma iniciativas sociales en evidencia defendible. Únete al equipo para colaborar en la medición y reporte del impacto social.
      </div>
      <div class="button-container">
        <a href="${joinLink}" class="button">Aceptar Invitación</a>
      </div>
      <div class="message" style="font-size: 14px; margin-bottom: 0;">
        O copia y pega el siguiente enlace en tu navegador:<br>
        <a href="${joinLink}" style="color: #FF6A00; word-break: break-all;">${joinLink}</a>
      </div>
    </div>
    <div class="footer">
      Este enlace es personal e intransferible. Si no esperabas esta invitación, puedes ignorar este correo.<br><br>
      &copy; ${new Date().getFullYear()} The Balance Corp.
    </div>
  </div>
</body>
</html>
  `;
}
