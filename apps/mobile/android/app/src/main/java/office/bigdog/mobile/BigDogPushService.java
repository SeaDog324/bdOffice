package office.bigdog.mobile;
import org.unifiedpush.android.connector.PushService;
import org.unifiedpush.android.connector.FailedReason;
import org.unifiedpush.android.connector.data.PushMessage;
import org.unifiedpush.android.connector.data.PushEndpoint;
import android.app.*;
import android.content.Intent;
import android.os.Build;
import android.content.pm.PackageManager;
import org.json.JSONObject;

/** Push is a wake-up hint only. Tasks and receipts are fetched and verified after opening the app. */
public class BigDogPushService extends PushService {
    @Override public void onNewEndpoint(PushEndpoint endpoint,String instance){getSharedPreferences("push",MODE_PRIVATE).edit().putString("endpoint",endpoint.getUrl()).remove("error").commit();}
    @Override public void onRegistrationFailed(FailedReason reason,String instance){getSharedPreferences("push",MODE_PRIVATE).edit().putString("error",reason.name()).commit();}
    @Override public void onUnregistered(String instance){getSharedPreferences("push",MODE_PRIVATE).edit().remove("endpoint").putString("error","UNREGISTERED").commit();}
    @Override public void onMessage(PushMessage message,String instance){
        try{
            if(message.getContent().length>4096)return;
            JSONObject data=new JSONObject(new String(message.getContent(),java.nio.charset.StandardCharsets.UTF_8));
            if(!"sync_required".equals(data.optString("type")))return;
            getSharedPreferences("push",MODE_PRIVATE).edit().putBoolean("needsSync",true).commit();
            if(Build.VERSION.SDK_INT>=33&&checkSelfPermission("android.permission.POST_NOTIFICATIONS")!=PackageManager.PERMISSION_GRANTED)return;
            NotificationManager manager=(NotificationManager)getSystemService(NOTIFICATION_SERVICE);
            manager.createNotificationChannel(new NotificationChannel("tasks","大狗任务",NotificationManager.IMPORTANCE_DEFAULT));
            PendingIntent open=PendingIntent.getActivity(this,0,new Intent(this,MainActivity.class),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
            manager.notify(7001,new Notification.Builder(this,"tasks").setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle("大狗任务有更新")
                .setContentText("打开应用查看结果或待确认事项").setContentIntent(open).setAutoCancel(true).build());
        }catch(Exception ignored){}
    }
}
