/**
 * Gera o par de chaves VAPID das notificações push. Rode NO SERVIDOR e cole as linhas no .env
 * (a chave privada nunca deve ir para o repositório nem para o navegador):
 *   pnpm vapid:generate
 * Trocar as chaves invalida as inscrições existentes (cada aparelho precisa ativar de novo).
 */
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
process.stdout.write(`VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}\nVAPID_SUBJECT=mailto:seu-email@exemplo.com\n`);
