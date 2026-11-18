package office.bigdog.mobile;

import android.app.Activity;
import android.webkit.WebView;
import android.util.Base64;
import org.webrtc.*;
import org.json.*;
import java.nio.ByteBuffer;
import java.util.*;
import java.util.concurrent.*;

/** Data-channel-only libwebrtc bridge. No audio/video tracks or media capture permissions. */
final class NativeRtc {
    private final Activity activity;
    private final WebView web;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Map<String, PeerConnection> peers = new ConcurrentHashMap<>();
    private final Map<String, DataChannel> channels = new ConcurrentHashMap<>();
    private final PeerConnectionFactory factory;
    NativeRtc(Activity activity, WebView web) {
        this.activity = activity; this.web = web;
        PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(activity).setEnableInternalTracer(false).createInitializationOptions());
        factory = PeerConnectionFactory.builder().createPeerConnectionFactory();
    }
    private void emit(JSONObject value) {
        activity.runOnUiThread(() -> web.evaluateJavascript("window.__bigdogRtc && window.__bigdogRtc(" + value.toString() + ")", null));
    }
    private void reply(String id, Object result, String error) {
        try { JSONObject value = new JSONObject().put("requestId", id); if(error != null) value.put("error",error); else value.put("value",result == null ? JSONObject.NULL : result); emit(value); } catch(Exception ignored) {}
    }
    private void event(String target, String type, Object value) {
        try { emit(new JSONObject().put("target",target).put("type",type).put("value",value == null ? JSONObject.NULL : value)); } catch(Exception ignored) {}
    }
    private JSONObject description(SessionDescription value) throws Exception {
        return new JSONObject().put("type",value.type.canonicalForm()).put("sdp",value.description);
    }
    private SdpObserver observer(String requestId, boolean creating) {
        return new SdpObserver() {
            public void onCreateSuccess(SessionDescription value) { try { reply(requestId,description(value),null); } catch(Exception e) { reply(requestId,null,"SDP_FAILED"); } }
            public void onSetSuccess() { reply(requestId,null,null); }
            public void onCreateFailure(String message) { reply(requestId,null,"SDP_CREATE_FAILED"); }
            public void onSetFailure(String message) { reply(requestId,null,"SDP_SET_FAILED"); }
        };
    }
    private JSONObject channel(String peerId, DataChannel data) throws Exception {
        String id=UUID.randomUUID().toString(); channels.put(id,data);
        data.registerObserver(new DataChannel.Observer() {
            public void onBufferedAmountChange(long previousAmount) { event(id,"buffered",data.bufferedAmount()); }
            public void onStateChange() { event(id,"state",data.state().name().toLowerCase(Locale.ROOT)); }
            public void onMessage(DataChannel.Buffer buffer) { byte[] bytes=new byte[buffer.data.remaining()];buffer.data.get(bytes);event(id,"message",Base64.encodeToString(bytes,Base64.NO_WRAP)); }
        });
        return new JSONObject().put("id",id).put("label",data.label()).put("state",data.state().name().toLowerCase(Locale.ROOT)).put("peerId",peerId);
    }
    public void request(String json) {
        if(json == null || json.length()>2*1024*1024)return;
        executor.execute(() -> {
            String requestId="";
            try {
                JSONObject call=new JSONObject(json);requestId=call.getString("requestId");
                String method=call.getString("method"), target=call.optString("target");JSONObject args=call.optJSONObject("args");if(args==null)args=new JSONObject();
                if(method.equals("create")) {
                    String id=UUID.randomUUID().toString();List<PeerConnection.IceServer> servers=new ArrayList<>();JSONArray list=args.optJSONArray("iceServers");
                    if(list!=null)for(int i=0;i<list.length();i++){JSONObject item=list.getJSONObject(i);Object urls=item.get("urls");List<String> addresses=new ArrayList<>();if(urls instanceof JSONArray){JSONArray a=(JSONArray)urls;for(int n=0;n<a.length();n++)addresses.add(a.getString(n));}else addresses.add(String.valueOf(urls));servers.add(PeerConnection.IceServer.builder(addresses).setUsername(item.optString("username")).setPassword(item.optString("credential")).createIceServer());}
                    PeerConnection.RTCConfiguration config=new PeerConnection.RTCConfiguration(servers);
                    config.iceTransportsType=args.optString("iceTransportPolicy").equals("relay")?PeerConnection.IceTransportsType.RELAY:PeerConnection.IceTransportsType.ALL;
                    PeerConnection peer=factory.createPeerConnection(config,new PeerConnection.Observer(){
                        public void onSignalingChange(PeerConnection.SignalingState state) {}
                        public void onIceConnectionChange(PeerConnection.IceConnectionState state){event(id,"iceConnectionState",state.name().toLowerCase(Locale.ROOT));}
                        public void onConnectionChange(PeerConnection.PeerConnectionState state){event(id,"connectionState",state.name().toLowerCase(Locale.ROOT));}
                        public void onIceConnectionReceivingChange(boolean receiving) {}
                        public void onIceGatheringChange(PeerConnection.IceGatheringState state){event(id,"iceGatheringState",state.name().toLowerCase(Locale.ROOT));if(state==PeerConnection.IceGatheringState.COMPLETE)event(id,"icecandidate",null);}
                        public void onIceCandidate(IceCandidate candidate){try{event(id,"icecandidate",new JSONObject().put("candidate",candidate.sdp).put("sdpMid",candidate.sdpMid).put("sdpMLineIndex",candidate.sdpMLineIndex));}catch(Exception ignored){}}
                        public void onIceCandidatesRemoved(IceCandidate[] candidates) {}
                        public void onAddStream(MediaStream stream) {}
                        public void onRemoveStream(MediaStream stream) {}
                        public void onDataChannel(DataChannel data){try{event(id,"datachannel",channel(id,data));}catch(Exception ignored){}}
                        public void onRenegotiationNeeded() {}
                    });
                    if(peer==null)throw new IllegalStateException();peers.put(id,peer);reply(requestId,id,null);return;
                }
                if(method.equals("send")){DataChannel data=channels.get(target);if(data==null || !data.send(new DataChannel.Buffer(ByteBuffer.wrap(Base64.decode(args.getString("data"),Base64.DEFAULT)),true)))throw new IllegalStateException();reply(requestId,data.bufferedAmount(),null);return;}
                if(method.equals("closeChannel")){DataChannel data=channels.remove(target);if(data!=null){data.unregisterObserver();data.close();data.dispose();}reply(requestId,null,null);return;}
                PeerConnection peer=peers.get(target);if(peer==null)throw new IllegalStateException();
                switch(method){
                    case "offer": peer.createOffer(observer(requestId,true),new MediaConstraints());break;
                    case "answer": peer.createAnswer(observer(requestId,true),new MediaConstraints());break;
                    case "local": peer.setLocalDescription(observer(requestId,false),new SessionDescription(SessionDescription.Type.fromCanonicalForm(args.getString("type")),args.getString("sdp")));break;
                    case "remote": peer.setRemoteDescription(observer(requestId,false),new SessionDescription(SessionDescription.Type.fromCanonicalForm(args.getString("type")),args.getString("sdp")));break;
                    case "candidate": if(!args.isNull("candidate"))peer.addIceCandidate(new IceCandidate(args.optString("sdpMid"),args.optInt("sdpMLineIndex"),args.getString("candidate")));reply(requestId,null,null);break;
                    case "channel": DataChannel.Init init=new DataChannel.Init();init.ordered=true;reply(requestId,channel(target,peer.createDataChannel(args.optString("label","bigdog"),init)),null);break;
                    case "stats": String callbackId=requestId;peer.getStats(report->{JSONArray result=new JSONArray();for(RTCStats stat:report.getStatsMap().values()){try{JSONObject row=new JSONObject(stat.getMembers());row.put("id",stat.getId()).put("type",stat.getType());result.put(row);}catch(Exception ignored){}}reply(callbackId,result,null);});break;
                    case "close": peers.remove(target);peer.close();peer.dispose();reply(requestId,null,null);break;
                    default: reply(requestId,null,"UNKNOWN_RTC_METHOD");
                }
            }catch(Exception error){reply(requestId,null,"NATIVE_RTC_FAILED");}
        });
    }
    void closeAll(){for(DataChannel c:channels.values()){c.unregisterObserver();c.close();c.dispose();}channels.clear();for(PeerConnection p:peers.values()){p.close();p.dispose();}peers.clear();factory.dispose();executor.shutdown();}
}
