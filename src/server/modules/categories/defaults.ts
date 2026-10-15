/**
 * Categorias iniciais. As palavras-chave (minúsculas, sem acento) alimentam o
 * classificador local e servem de dica para os modelos de IA. São editáveis pelo usuário.
 */
export interface DefaultSubcategory {
  name: string;
  keywords: string[];
}

export interface DefaultCategory {
  name: string;
  kind: "EXPENSE" | "INCOME";
  icon: string;
  color: string;
  subcategories: DefaultSubcategory[];
}

export const DEFAULT_CATEGORIES: DefaultCategory[] = [
  {
    name: "Alimentação",
    kind: "EXPENSE",
    icon: "utensils",
    color: "#f97316",
    subcategories: [
      { name: "Supermercado", keywords: ["mercado", "supermercado", "atacadao", "assai", "carrefour", "pao de acucar", "extra", "hiper", "compras do mes", "atacarejo", "mercadinho", "bompreco", "big"] },
      { name: "Restaurantes", keywords: ["restaurante", "almoco", "jantar", "churrascaria", "rodizio", "self service", "pizzaria", "sushi", "japones", "boteco", "bar"] },
      { name: "Delivery", keywords: ["ifood", "delivery", "rappi", "pedido", "entrega", "zé delivery", "ze delivery", "aiqfome"] },
      { name: "Padaria", keywords: ["padaria", "pao", "paes", "panificadora", "confeitaria"] },
      { name: "Lanches", keywords: ["lanche", "lanchonete", "cafe", "cafeteria", "salgado", "hamburguer", "mcdonalds", "burger king", "sorvete", "acai", "pastel", "coxinha", "starbucks"] },
      { name: "Feira", keywords: ["feira", "hortifruti", "sacolao", "verdura", "fruta", "frutas", "legumes", "ceasa", "acougue", "peixaria"] },
    ],
  },
  {
    name: "Moradia",
    kind: "EXPENSE",
    icon: "house",
    color: "#0ea5e9",
    subcategories: [
      { name: "Aluguel", keywords: ["aluguel", "locacao", "imobiliaria"] },
      { name: "Financiamento", keywords: ["financiamento", "prestacao da casa", "prestacao do apartamento", "caixa habitacao"] },
      { name: "Condomínio", keywords: ["condominio", "taxa condominial"] },
      { name: "Energia", keywords: ["energia", "luz", "conta de luz", "neoenergia", "celpe", "enel", "cemig", "light", "eletricidade"] },
      { name: "Água", keywords: ["agua", "conta de agua", "compesa", "sabesp", "saneamento", "cedae"] },
      { name: "Internet", keywords: ["internet", "wifi", "fibra", "banda larga", "vivo fibra", "claro net", "oi fibra", "telefone fixo", "celular", "plano de celular", "recarga"] },
      { name: "Gás", keywords: ["gas", "botijao", "gas de cozinha", "copergas", "comgas"] },
      { name: "Manutenção", keywords: ["manutencao", "reforma", "conserto", "eletricista", "encanador", "pintor", "material de construcao", "leroy", "ferragem"] },
    ],
  },
  {
    name: "Transporte",
    kind: "EXPENSE",
    icon: "car",
    color: "#6366f1",
    subcategories: [
      { name: "Combustível", keywords: ["gasolina", "combustivel", "abasteci", "abastecer", "abastecimento", "posto", "etanol", "alcool", "diesel", "gnv", "shell", "ipiranga", "petrobras"] },
      { name: "Estacionamento", keywords: ["estacionamento", "zona azul", "valet", "parking"] },
      { name: "Aplicativos de transporte", keywords: ["uber", "99pop", "99 pop", "taxi", "cabify", "indriver", "corrida", "onibus", "metro", "passagem de onibus", "vem"] },
      { name: "Manutenção do veículo", keywords: ["mecanico", "oficina", "revisao", "pneu", "troca de oleo", "oleo", "lava jato", "lavagem", "borracharia", "pecas"] },
      { name: "Seguro", keywords: ["seguro do carro", "seguro auto", "seguro do veiculo", "seguro da moto"] },
      { name: "Impostos", keywords: ["ipva", "licenciamento", "multa", "detran", "dpvat"] },
    ],
  },
  {
    name: "Saúde",
    kind: "EXPENSE",
    icon: "heart-pulse",
    color: "#ef4444",
    subcategories: [
      { name: "Consultas", keywords: ["consulta", "medico", "dentista", "psicologo", "terapia", "fisioterapia", "pediatra", "nutricionista", "clinica"] },
      { name: "Exames", keywords: ["exame", "exames", "laboratorio", "ultrassom", "raio x", "hemograma", "ressonancia"] },
      { name: "Medicamentos", keywords: ["farmacia", "remedio", "remedios", "medicamento", "drogaria", "pague menos", "drogasil", "raia", "pacheco"] },
      { name: "Plano de saúde", keywords: ["plano de saude", "unimed", "hapvida", "amil", "bradesco saude", "sulamerica", "plano odontologico"] },
    ],
  },
  {
    name: "Família",
    kind: "EXPENSE",
    icon: "baby",
    color: "#ec4899",
    subcategories: [
      { name: "Despesas com filhos", keywords: ["filho", "filha", "bebe", "brinquedo", "baba", "creche"] },
      { name: "Fraldas", keywords: ["fralda", "fraldas", "lenco umedecido", "pampers", "huggies"] },
      { name: "Alimentação infantil", keywords: ["leite em po", "papinha", "formula infantil", "nan", "aptamil"] },
      { name: "Educação", keywords: ["escola", "mensalidade escolar", "material escolar", "uniforme", "farda"] },
      { name: "Vestuário infantil", keywords: ["roupa de bebe", "roupa infantil", "sapato infantil"] },
      { name: "Outros", keywords: [] },
    ],
  },
  {
    name: "Compras",
    kind: "EXPENSE",
    icon: "shopping-bag",
    color: "#a855f7",
    subcategories: [
      { name: "Roupas", keywords: ["roupa", "roupas", "camisa", "calca", "vestido", "sapato", "tenis", "renner", "riachuelo", "c&a", "cea", "zara", "shein", "hering"] },
      { name: "Eletrônicos", keywords: ["televisao", "tv", "notebook", "celular novo", "smartphone", "iphone", "fone", "tablet", "computador", "monitor", "eletronico", "videogame", "playstation", "xbox"] },
      { name: "Casa", keywords: ["casa", "movel", "moveis", "sofa", "cama", "colchao", "utensilio", "panela", "decoracao", "eletrodomestico", "geladeira", "fogao", "maquina de lavar", "magazine luiza", "casas bahia", "tok stok"] },
      { name: "Presentes", keywords: ["presente", "presentes", "aniversario de", "lembrancinha"] },
    ],
  },
  {
    name: "Lazer",
    kind: "EXPENSE",
    icon: "palmtree",
    color: "#14b8a6",
    subcategories: [
      { name: "Viagens", keywords: ["viagem", "hotel", "pousada", "passagem aerea", "passagem", "airbnb", "booking", "latam", "gol", "azul", "hospedagem"] },
      { name: "Passeios", keywords: ["passeio", "parque", "praia", "museu", "zoologico", "clube"] },
      { name: "Cinema", keywords: ["cinema", "filme", "ingresso", "teatro", "show"] },
      { name: "Entretenimento", keywords: ["entretenimento", "jogo", "boliche", "festa", "balada", "evento"] },
    ],
  },
  {
    name: "Assinaturas",
    kind: "EXPENSE",
    icon: "repeat",
    color: "#8b5cf6",
    subcategories: [
      { name: "Streaming", keywords: ["netflix", "spotify", "disney", "prime video", "amazon prime", "hbo", "max", "globoplay", "deezer", "youtube premium", "apple tv", "paramount", "streaming"] },
      { name: "Aplicativos", keywords: ["aplicativo", "app store", "google play", "icloud", "google one"] },
      { name: "Softwares", keywords: ["software", "licenca", "microsoft 365", "office", "adobe", "canva", "chatgpt", "claude"] },
      { name: "Serviços recorrentes", keywords: ["assinatura", "academia", "smart fit", "clube de assinatura", "mensalidade"] },
    ],
  },
  {
    name: "Educação",
    kind: "EXPENSE",
    icon: "graduation-cap",
    color: "#0891b2",
    subcategories: [
      { name: "Cursos", keywords: ["curso", "cursos", "udemy", "alura", "aula", "workshop", "ingles", "idioma"] },
      { name: "Livros", keywords: ["livro", "livros", "livraria", "kindle", "ebook"] },
      { name: "Mensalidades", keywords: ["faculdade", "pos graduacao", "mba", "universidade", "mensalidade da faculdade"] },
    ],
  },
  {
    name: "Trabalho",
    kind: "EXPENSE",
    icon: "briefcase",
    color: "#475569",
    subcategories: [
      { name: "Ferramentas", keywords: ["ferramenta", "ferramentas"] },
      { name: "Serviços", keywords: ["contador", "contabilidade", "freelancer", "servico profissional", "hospedagem de site", "dominio"] },
      { name: "Equipamentos", keywords: ["equipamento", "impressora", "cadeira de escritorio"] },
      { name: "Custos profissionais", keywords: ["coworking", "cartao de visita", "anuidade", "crc", "oab", "crm"] },
    ],
  },
  {
    name: "Outras",
    kind: "EXPENSE",
    icon: "ellipsis",
    color: "#64748b",
    subcategories: [
      { name: "Impostos", keywords: ["imposto", "iptu", "irpf", "darf", "das", "taxa", "tributo"] },
      { name: "Tarifas", keywords: ["tarifa", "tarifa bancaria", "anuidade do cartao", "juros", "iof", "multa de atraso", "encargos"] },
      { name: "Doações", keywords: ["doacao", "dizimo", "oferta", "vaquinha", "caridade"] },
      { name: "Despesas não classificadas", keywords: [] },
    ],
  },
  // ---------------------------------------------------------------- Receitas
  {
    name: "Trabalho",
    kind: "INCOME",
    icon: "briefcase",
    color: "#059669",
    subcategories: [
      { name: "Salário", keywords: ["salario", "pagamento do salario", "holerite", "contracheque", "adiantamento", "decimo terceiro", "13o salario", "ferias"] },
      { name: "Serviços", keywords: ["cliente", "trabalho", "freela", "freelance", "servico", "projeto", "consultoria", "honorarios", "marketing"] },
      { name: "Comissões", keywords: ["comissao", "comissoes", "bonus", "participacao nos lucros", "plr"] },
    ],
  },
  {
    name: "Investimentos",
    kind: "INCOME",
    icon: "trending-up",
    color: "#10b981",
    subcategories: [
      { name: "Rendimentos", keywords: ["rendimento", "rendimentos", "juros", "cdb", "poupanca", "tesouro"] },
      { name: "Dividendos", keywords: ["dividendo", "dividendos", "jcp", "proventos"] },
    ],
  },
  {
    name: "Outras receitas",
    kind: "INCOME",
    icon: "plus-circle",
    color: "#22c55e",
    subcategories: [
      { name: "Reembolsos", keywords: ["reembolso", "estorno", "devolucao", "cashback"] },
      { name: "Presentes recebidos", keywords: ["presente", "ganhei"] },
      { name: "Vendas", keywords: ["vendi", "venda", "vendas"] },
      { name: "Aluguel recebido", keywords: ["aluguel recebido", "inquilino"] },
      { name: "Outros", keywords: [] },
    ],
  },
];
