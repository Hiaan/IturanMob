# Conexão com bancos (Open Finance via Meu Pluggy)

Traz os lançamentos das contas e cartões automaticamente, sem baixar extrato. Usa o **Meu Pluggy**,
gratuito para uso pessoal.

## Limites do Meu Pluggy (gratuito)

- Até **5 bancos** por CPF.
- Os dados são atualizados **1 vez por dia** (o app busca a cada 6 horas e no botão "Buscar agora").
- **Uso pessoal**: não pode ser usado para fins comerciais nem para dados de outras pessoas.
- A listagem automática de conexões é recurso pago da Pluggy: por isso o ID de cada banco é colado
  à mão.

## Passo a passo

1. Crie a conta em <https://meu.pluggy.ai> e conecte lá os seus bancos.
2. Em <https://dashboard.pluggy.ai>, crie uma aplicação e copie o **Client ID** e o **Client Secret**.
3. No app, em **Integrações → Bancos (Open Finance)**, cole os dois e salve. O app confere na
   Pluggy antes de salvar; os dois ficam cifrados no banco de dados e nunca voltam para a tela.
4. No painel da Pluggy, conecte o Meu Pluggy à sua aplicação (opção de conectar/testar conexão) e
   copie o **ID da conexão (item)** de cada banco. Os nomes dos botões no site da Pluggy podem mudar.
5. Cole o ID em **Adicionar banco**. As contas e cartões do banco aparecem; ligue cada um a uma
   conta ou cartão do app (cartões com os mesmos 4 últimos dígitos já vêm ligados).

## Como os lançamentos entram

- **Só leitura**: o app nunca movimenta dinheiro.
- Cada busca vira uma **prévia na tela Importação** (a mesma dos arquivos): duplicados, lançamentos
  já registrados (conciliados), parcelas, pagamento de fatura e regras funcionam igual.
- O id do lançamento no banco é guardado: **o mesmo lançamento nunca entra duas vezes**, mesmo em
  buscas repetidas ou com períodos sobrepostos.
- Lançamentos ainda **pendentes** no banco esperam até serem confirmados. Lançamentos em outra moeda
  ficam de fora (registre à mão).
- Opção **Importar direto**: pula a conferência; duplicados e já registrados continuam de fora;
  valores divergentes viram pendência.
- Primeira busca de cada conta: os últimos 30 dias (ajustável). Depois, a partir do último
  lançamento trazido, com 5 dias de folga.

## Privacidade

- Credenciais cifradas (AES-256-GCM); a chave temporária da Pluggy fica só na memória.
- Nada das credenciais ou dos lançamentos vai para os logs.
- Contas e cartões privados: os avisos de lançamentos novos vão só para o titular, no app (nunca no
  grupo do WhatsApp).
- Remover a conexão apaga credenciais, bancos e vínculos; os lançamentos já importados continuam.

## Desenvolvimento

`OPEN_FINANCE_SIMULATOR=true` libera o **simulador** (dados de exemplo, identificados como
"SIMULADOR" na tela; use um ID que comece com `simulado`, ex.: `simulado-0000-banco`). Em produção
fica desligado.
