package office.bigdog.mobile;
import android.app.Activity;
import android.webkit.WebView;
import org.json.*;
import okhttp3.*;
import java.io.IOException;
import java.util.concurrent.*;

/** Platform TLS validation is always used. No permissive trust manager or certificate bypass. */
final class NativeNetwork {
    private final Activity activity; private final WebView web;
    private final OkHttpClient client = new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).callTimeout(180,TimeUnit.SECONDS).build();
    private final ConcurrentHashMap<String,WebSocket> sockets=new ConcurrentHashMap<>();
    NativeNetwork(Activity activity,WebView web){this.activity=activity;this.web=web;}
    private void emit(String id,String type,Object value){try{JSONObject data=new JSONObject().put("id",id).put("type",type).put("value",value==null?JSONObject.NULL:value);activity.runOnUiThread(()->web.evaluateJavascript("window.__bigdogNetwork && window.__bigdogNetwork("+data+")",null));}catch(Exception ignored){}}
    private boolean permitted(String input){try{java.net.URI uri=new java.net.URI(input);String scheme=uri.getScheme(),host=uri.getHost();return uri.getUserInfo()==null && host!=null && ("https".equals(scheme)||"wss".equals(scheme)||(("http".equals(scheme)||"ws".equals(scheme))&&(host.equals("127.0.0.1")||host.equals("localhost")||host.equals("10.0.2.2"))));}catch(Exception e){return false;}}
    void request(String json){
        String id="";
        try{
            JSONObject call=new JSONObject(json);id=call.getString("id");String method=call.getString("method");final String key=id;
            if(method.equals("ws-send")){WebSocket socket=sockets.get(id);if(socket==null||!socket.send(call.getString("data")))emit(id,"error","SOCKET_CLOSED");return;}
            if(method.equals("ws-close")){WebSocket socket=sockets.remove(id);if(socket!=null)socket.close(call.optInt("code",1000),call.optString("reason",""));return;}
            String url=call.getString("url");if(!permitted(url))throw new IllegalArgumentException();
            Request.Builder builder=new Request.Builder().url(url);
            if(method.equals("ws-open")){
                WebSocket socket=client.newWebSocket(builder.build(),new WebSocketListener(){
                    @Override public void onOpen(WebSocket ws,Response response){emit(key,"open",null);}
                    @Override public void onMessage(WebSocket ws,String message){if(message.length()>4*1024*1024){ws.close(1009,"frame limit");return;}emit(key,"message",message);}
                    @Override public void onClosing(WebSocket ws,int code,String reason){ws.close(code,reason);}
                    @Override public void onClosed(WebSocket ws,int code,String reason){sockets.remove(key);try{emit(key,"close",new JSONObject().put("code",code).put("reason",reason));}catch(Exception ignored){}}
                    @Override public void onFailure(WebSocket ws,Throwable failure,Response response){sockets.remove(key);emit(key,"error","NETWORK_ERROR");try{emit(key,"close",new JSONObject().put("code",1006).put("reason","connection failed"));}catch(Exception ignored){}}
                });sockets.put(key,socket);return;
            }
            if(!method.equals("http"))throw new IllegalArgumentException();
            JSONObject headers=call.optJSONObject("headers");if(headers!=null){java.util.Iterator<String> fields=headers.keys();while(fields.hasNext()){String field=fields.next();if(field.equalsIgnoreCase("authorization")||field.equalsIgnoreCase("content-type"))builder.header(field,headers.getString(field));}}
            String verb=call.optString("verb","GET");if(!java.util.Arrays.asList("GET","POST","DELETE").contains(verb))throw new IllegalArgumentException();
            String body=call.optString("body","");if(body.length()>2*1024*1024)throw new IllegalArgumentException();
            builder.method(verb,verb.equals("GET")?null:RequestBody.create(body,MediaType.get("application/json")));
            client.newCall(builder.build()).enqueue(new Callback(){
                public void onFailure(Call call,IOException error){emit(key,"error","NETWORK_ERROR");}
                public void onResponse(Call call,Response response){try(response){ResponseBody responseBody=response.body();if(responseBody==null||responseBody.contentLength()>4*1024*1024)throw new IOException();java.io.ByteArrayOutputStream output=new java.io.ByteArrayOutputStream();byte[] buffer=new byte[8192];java.io.InputStream input=responseBody.byteStream();int length;while((length=input.read(buffer))!=-1){if(output.size()+length>4*1024*1024)throw new IOException();output.write(buffer,0,length);}emit(key,"http",new JSONObject().put("status",response.code()).put("body",new String(output.toByteArray(),java.nio.charset.StandardCharsets.UTF_8)));}catch(Exception e){emit(key,"error","INVALID_RESPONSE");}}
            });
        }catch(Exception e){emit(id,"error","INVALID_NETWORK_REQUEST");}
    }
    void close(){for(WebSocket socket:sockets.values())socket.close(1000,"app closed");sockets.clear();client.dispatcher().cancelAll();client.connectionPool().evictAll();}
}
