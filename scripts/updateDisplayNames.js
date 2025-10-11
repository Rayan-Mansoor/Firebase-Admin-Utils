// scripts/updateDisplayNames.js
const { auth, db } = require("../firebaseAdmin");

async function updateDisplayNames() {
  try {
    console.log("🚀 Starting display name update for all users...");
    
    let processedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    // Get all user documents from Firestore
    console.log("📄 Fetching user documents from Firestore...");
    const snapshot = await db.collection("users").get();
    
    console.log(`📊 Found ${snapshot.size} user documents to process`);

    for (const doc of snapshot.docs) {
      processedCount++;
      const uid = doc.id; // doc ID == uid
      const data = doc.data();

      try {
        // Access basicInfo subfields
        const firstName = data.basicInfo?.firstName || "";
        const lastName = data.basicInfo?.lastName || "";
        const fullName = `${firstName} ${lastName}`.trim();

        if (fullName) {
          // Get current user from Firebase Auth to check if display name already matches
          let currentUser;
          try {
            currentUser = await auth.getUser(uid);
          } catch (authError) {
            console.log(`⚠️  Auth user ${uid} not found, skipping (user may have been deleted)`);
            skippedCount++;
            continue;
          }

          // Check if display name already matches
          if (currentUser.displayName === fullName) {
            console.log(`⏭️  Skipped ${uid} → "${fullName}" (already up to date)`);
            skippedCount++;
          } else {
            const previousDisplayName = currentUser.displayName || "null";
            await auth.updateUser(uid, { displayName: fullName });
            console.log(`✅ Updated ${uid} → "${fullName}" (was: "${previousDisplayName}")`);
            updatedCount++;
          }
        } else {
          const reasons = [];
          if (!firstName) reasons.push("missing firstName");
          if (!lastName) reasons.push("missing lastName");
          if (!data.basicInfo) reasons.push("missing basicInfo");
          
          console.log(`⚠️  Skipped ${uid} → ${reasons.join(", ")}`);
          skippedCount++;
        }

        // Add a small delay to avoid overwhelming Firebase Auth
        await new Promise(resolve => setTimeout(resolve, 50));

      } catch (error) {
        console.error(`❌ Error processing user ${uid}:`, error.message);
        errorCount++;
      }
    }

    console.log("\n📊 Update Summary:");
    console.log(`   Total processed: ${processedCount}`);
    console.log(`   Updated: ${updatedCount}`);
    console.log(`   Skipped (already up to date): ${skippedCount - errorCount}`);
    console.log(`   Errors: ${errorCount}`);
    
    if (updatedCount > 0) {
      console.log("🎉 Display name update completed successfully!");
    } else {
      console.log("ℹ️  No updates needed - all display names are already up to date!");
    }

  } catch (error) {
    console.error("💥 Fatal error during display name update:", error);
  } finally {
    // Exit the process
    process.exit(0);
  }
}

updateDisplayNames();