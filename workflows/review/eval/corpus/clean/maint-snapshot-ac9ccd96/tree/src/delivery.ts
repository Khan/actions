export interface Transport {send(body: string): string;}
export const deliver = (transport: Transport, body: string): string => transport.send(body);
