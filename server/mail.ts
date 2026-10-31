// Mails transactionnels : Resend par son API HTTP (`fetch`, pas de SDK) en
// production ; en test, une boîte en mémoire ; en développement sans clé,
// le lien est écrit dans la console. Expéditeur fixe du domaine du serveur.
export interface Mail {
  to: string;
  subject: string;
  text: string;
}
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export function resendMailer(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): Mailer {
  return {
    async send(mail) {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(`Resend a refusé l'envoi (${res.status})${body.message ? ' : ' + body.message : ''}`);
      }
    },
  };
}

export function memoryMailer(): Mailer & { sent: Mail[] } {
  const sent: Mail[] = [];
  return {
    sent,
    async send(mail) {
      sent.push(mail);
    },
  };
}

export function consoleMailer(): Mailer {
  return {
    async send(mail) {
      console.log(`[mail non envoyé, pas de RESEND_API_KEY] à ${mail.to} · ${mail.subject}\n${mail.text}`);
    },
  };
}
