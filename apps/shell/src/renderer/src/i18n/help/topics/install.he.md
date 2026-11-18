# התקנת BigDogOffice

הורידו את BigDogOffice מ[דף הגרסאות](https://github.com/whdite/bdOffice/releases). הפלטפורמות, הארכיטקטורות ופרטי החתימה הזמינים מפורטים בכל גרסה; השתמשו בקבצים המצורפים לאותה גרסה.

## בחירת הקובץ למחשב שלך

| פלטפורמה                             | דרישות                                                | קובץ                     |
| ------------------------------------ | ----------------------------------------------------- | ------------------------ |
| **macOS** — Apple Silicon            | macOS 11+                                             | `.dmg` (arm64)           |
| **macOS** — Intel                    | macOS 11+                                             | `.dmg` (x64)             |
| **Windows** — רוב ה-PC               | Windows 10+, Intel/AMD                                | מתקין `-x64-Setup.exe`   |
| **Windows** על Arm                   | Windows 11 על Arm (Snapdragon X ודומה)                | מתקין `-arm64-Setup.exe` |
| **Linux** — Debian / Ubuntu          | x86_64, glibc 2.34+ (Ubuntu 22.04 או חדש יותר)        | `.deb`                   |
| **Linux** — Fedora / RHEL / openSUSE | x86_64, glibc 2.34+ (Fedora 35+, RHEL 9+, Leap 15.6+) | `.rpm`                   |
| **Linux** — כל דבר אחר               | x86_64, glibc 2.34+, FUSE 2                           | `.AppImage`              |

גרסאות ישנות יותר נשארות בעמוד ההפצות.

## ב-macOS

פתחו את ה-`.dmg` וגררו את **BigDogOffice** אל Applications. בגרסת Intel ההפעלה הראשונה מבקשת אישור לפתיחה: לחצו לחיצה ימנית על האפליקציה ב-Applications ▸ פתיחה. זה Gatekeeper מול דיסק-אימג' שנראה לא חתום, לא הורדה פגומה.

## ב-Windows

הפעילו את מתקין ה-`.exe`. הוא מוסיף את BigDogOffice לתפריט ההתחלה ורושם `.docx`, `.xlsx`, `.pptx`, `.pdf` ודומים, כך שלחיצה כפולה על קובץ פותחת אותו.

## ב-Linux

**Debian / Ubuntu**

```sh
sudo apt install ./BigDogOffice-<version>-amd64.deb
```

**Fedora / RHEL / openSUSE**

```sh
sudo dnf install ./BigDogOffice-<version>-x86_64.rpm     # Fedora / RHEL family
sudo zypper install ./BigDogOffice-<version>-x86_64.rpm  # openSUSE
```

**AppImage** — רץ מהמקום שבו הוא נמצא, בלי שום שלב התקנה:

```sh
chmod +x BigDogOffice-<version>-x64.AppImage
./BigDogOffice-<version>-x64.AppImage
```

הוא זקוק לסביבת הריצה FUSE 2. אם אתם מעדיפים לא להתקין אותה, הפעילו אותו עם `--appimage-extract-and-run`, ואז החולקה המבודדת עובדת מהתיקייה שחולצה.

## הגרסה שאתם מריצים

**הגדרות ▸ אודות** הוא המקום שבו האפליקציה מדווחת על הגרסה שיש לכם, על הערוץ שאליו היא עוברת ועל מקום מושבו של הפרויקט. כשמתפרסמת באותו ערוץ גרסה חדשה יותר, אותה חלונית מציעה את העדכון; התקנה של Flatpak, Nix או Docker אינה מציעה אותו, משום שהיא מוחלפת בכלי שהביא אותה לשם.

## שורת הפקודה מגיעה עמה

כל התקנה כוללת פקודת `bigdogoffice` שמדברת עם אותם מנועים שהחלון משתמש בהם, ולכן השניים לעולם אינם חלוקים לגבי קובץ. ב-macOS וב-Windows היא נמצאת בתוך חבילת האפליקציה; ו-`bigdogoffice install-cli` מציבה אותה ב-`PATH` שלכם. ראו **שורת פקודה וסוכנים** למה שהיא יודעת לעשות.
