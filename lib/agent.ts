import { tool, type InferUITools, type UIMessage } from 'ai';
import { buildCart, cartSchema, isQuarantined, matchingProducts, safeProduct, searchSchema } from './shop';
import { audit, catalog } from './db';

export const shoppingTools = {
  searchProducts: tool({
    description: 'USD 카탈로그 검색. 위험 상품은 서버에서 격리되며 설명은 모델에게 전달하지 않는다. 핵심어 OR 검색, 전체 검색은 빈 문자열.',
    inputSchema: searchSchema,
    execute: async ({ query, maxPrice }) => {
      const matches = matchingProducts(query, maxPrice, await catalog());
      const blocked = matches.filter(isQuarantined);
      await audit('searchProducts', blocked.length ? 'FILTERED' : 'ALLOWED', JSON.stringify({ matched: matches.length, blockedIds: blocked.map(p => p.id) }));
      return { products: matches.filter(p => !isQuarantined(p)).map(safeProduct), quarantinedCount: blocked.length };
    },
  }),
  buildCart: tool({
    description: '상품 ID와 수량으로 전체 장바구니를 구성한다. USD 예산, 재고, 상품당 최대 5개, 격리 여부를 서버가 검증한다. 승인이나 결제는 수행하지 않는다.',
    inputSchema: cartSchema,
    execute: async ({ budget, items }) => {
      const result = buildCart(budget, items, await catalog());
      await audit('buildCart', result.ok ? 'ALLOWED' : 'BLOCKED', result.ok ? JSON.stringify({ totalCents: result.cart.totalCents, productIds: result.cart.items.map(p => p.id) }) : result.error);
      return result;
    },
  }),
};
export type ShoppingMessage = UIMessage<unknown, never, InferUITools<typeof shoppingTools>>;
