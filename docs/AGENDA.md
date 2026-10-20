# Agenda, resumo da manhã e Google Agenda

## Agenda

- Tela **Agenda**: compromissos com data, hora (ou dia todo), local, observações e lembrete.
- **Compartilhado** (padrão): todos da família veem; lembrete e resumo vão para o grupo do WhatsApp.
- **Privado**: só a pessoa dona vê; lembrete e resumo só para ela, no app — **nunca no grupo**.

### Pelo WhatsApp (sem IA)

| Mensagem | O que faz |
|---|---|
| `marca dentista amanhã às 15h` | Compromisso compartilhado com aviso 1 hora antes |
| `agendar reunião da escola dia 25 às 19:30` | Idem |
| `lembrete pagar o IPVA sexta` | Compromisso do dia todo (entra no resumo da manhã) |
| `agenda de hoje` · `o que tenho amanhã?` · `agenda da semana` | Lista os compartilhados |
| `desmarcar dentista` | Desmarca o próximo compromisso com esse nome |

Frase com valor em dinheiro ("marca 50 reais no mercado") continua sendo lançamento.

## Resumo da manhã

Todo dia, na hora escolhida em **Configurações** (padrão 7h; dá para desligar): compromissos do dia,
contas que vencem hoje, contas vencidas e gastos de ontem — no app e no grupo do WhatsApp, no recorte
da família (contas e cartões privados fora). Compromissos privados vão num resumo à parte, só para a
pessoa, no app. Se o servidor estiver fora na hora, o resumo sai em até 3 horas; depois disso, não.

## Google Agenda (somente leitura)

Cada pessoa conecta a **própria** agenda. Os eventos entram como **privados** dela (só ela vê, nada
vai para o grupo), a menos que ela ligue "Compartilhar meus eventos com a família". Só título,
horário e local são copiados (a descrição não). Eventos do Google não são editados no app.

### Configuração (uma vez, por quem administra a família)

1. Em <https://console.cloud.google.com>, crie um projeto e ative a **Google Calendar API**.
2. Em **Tela de consentimento OAuth**, escolha **Externo** e adicione os e-mails da família como
   usuários de teste (no modo de teste, o Google mostra um aviso de app não verificado — esperado
   para uso pessoal).
3. Em **Credenciais**, crie um **ID do cliente OAuth** do tipo **Aplicativo da Web** e cadastre o URI
   de redirecionamento `https://SEU-DOMINIO/api/v1/integrations/google/callback` (a tela mostra o
   endereço certo, com botão de copiar).
4. Cole o Client ID e o Client Secret em **Integrações → Google Agenda** (ficam cifrados).

Depois, cada pessoa toca em **Conectar minha agenda do Google** na tela Agenda. A agenda é lida a
cada 30 minutos (de ontem até 60 dias à frente). Desconectar revoga o acesso no Google e tira as
cópias dos eventos do app (nada é apagado no Google).

Sem custo: a Google Calendar API é gratuita dentro das cotas de uso pessoal.

## Desenvolvimento

`GOOGLE_CALENDAR_SIMULATOR=true` libera a "agenda simulada" (eventos de exemplo, identificados como
simulados). Em produção fica desligado.
