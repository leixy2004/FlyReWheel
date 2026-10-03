/** Normalize Node's Request before passing it to a different undici version. */
export async function localRequest(input: RequestInfo | URL, init: RequestInit | undefined, origin: string) {
 const request=input instanceof Request?input:undefined;
 const url=new URL(request?request.url:String(input));
 if(url.origin!==origin||url.username||url.password)throw new Error('local origin required');
 const method=init?.method??request?.method??'GET';
 const headers=new Headers(request?.headers);
 new Headers(init?.headers).forEach((value,key)=>headers.set(key,value));
 const body=init?.body??(request&&method!=='GET'&&method!=='HEAD'?await request.arrayBuffer():undefined);
 if(body instanceof ArrayBuffer&&body.byteLength>65536)throw new Error('request body bound');
 return {url:url.href,init:{...init,method,headers:Object.fromEntries(headers),body,signal:init?.signal??request?.signal,redirect:'error' as const}};
}
