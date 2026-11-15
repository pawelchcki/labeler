import java.util.Properties

plugins { id("com.android.application"); id("com.google.devtools.ksp") }
val uploadProperties = Properties()
val uploadPropertiesFile = rootProject.file(".signing/upload.properties")
if (uploadPropertiesFile.isFile) uploadPropertiesFile.inputStream().use { uploadProperties.load(it) }
android {
    namespace = "net.chcki.labeler"
    ndkVersion = "27.2.12479018"
    compileSdk { version = release(37) { minorApiLevel = 0 } }
    defaultConfig { applicationId = "net.chcki.labeler"; minSdk = 31; targetSdk = 36; versionCode = 1; versionName = "0.1.0"; testInstrumentationRunner = "net.chcki.labeler.BleConnectionSmokeTest"; ndk { abiFilters += "arm64-v8a" } }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    signingConfigs {
        if (uploadPropertiesFile.isFile) create("upload") {
            storeFile = rootProject.file(".signing/upload.keystore")
            storePassword = uploadProperties.getProperty("storePassword")
            keyAlias = "upload"
            keyPassword = uploadProperties.getProperty("storePassword")
        }
    }
    buildTypes { release {
        isMinifyEnabled = false
        ndk { debugSymbolLevel = "SYMBOL_TABLE" }
        if (uploadPropertiesFile.isFile) signingConfig = signingConfigs.getByName("upload")
    } }
}
dependencies {
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("androidx.appfunctions:appfunctions:1.0.0-rc01")
    ksp("androidx.appfunctions:appfunctions-compiler:1.0.0-rc01")
}
val buildRust by tasks.registering(Exec::class) {
    workingDir(rootProject.projectDir)
    commandLine("sh", "scripts/build-rust.sh")
    inputs.file(rootProject.file("scripts/build-rust.sh"))
    inputs.dir(rootProject.file("core/src"))
    inputs.dir(rootProject.file("core/assets"))
    inputs.file(rootProject.file("core/Cargo.toml"))
    inputs.file(rootProject.file("core/Cargo.lock"))
    outputs.file("src/main/jniLibs/arm64-v8a/libaction_printer_core.so")
}
tasks.named("preBuild") { dependsOn(buildRust) }

tasks.matching { it.name == "validateSigningRelease" || it.name == "packageReleaseBundle" || it.name == "packageRelease" }.configureEach {
    doFirst { check(uploadPropertiesFile.isFile) { "Run python3 scripts/init-upload-key.py before building a release." } }
}
