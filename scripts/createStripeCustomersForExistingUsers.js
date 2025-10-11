const { auth, db } = require("../firebaseAdmin");
const STRIPE_API_KEY = process.env.STRIPE_API_KEY;
if (!STRIPE_API_KEY) {
  throw new Error("Set STRIPE_API_KEY in your .env before running this script.");
}
const stripe = require("stripe")(STRIPE_API_KEY);

async function createStripeCustomersForExistingUsers() {
  try {
    console.log("🚀 Starting Stripe customer creation for existing users...");
    
    let processedCount = 0;
    let createdCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    // Get all users from Firebase Auth (handles pagination automatically)
    const listAllUsers = async (nextPageToken) => {
      const listUsersResult = await auth.listUsers(1000, nextPageToken);
      
      for (const userRecord of listUsersResult.users) {
        processedCount++;
        
        try {
          // Check if user already has a stripe_customers document
          const stripeDoc = await db.collection('stripe_customers').doc(userRecord.uid).get();
          
          if (stripeDoc.exists) {
            console.log(`⏭️  Skipped ${userRecord.uid} (${userRecord.email}) - already has Stripe customer`);
            skippedCount++;
            continue;
          }

          // Check if user has an email
          if (!userRecord.email) {
            console.log(`⚠️  Skipped ${userRecord.uid} - no email address`);
            skippedCount++;
            continue;
          }

          // Create Stripe customer
          console.log(`🔄 Creating Stripe customer for ${userRecord.uid} (${userRecord.email})...`);
          
          const customer = await stripe.customers.create({ 
            email: userRecord.email,
            metadata: {
              firebase_uid: userRecord.uid
            }
          });

          // Create setup intent
          const intent = await stripe.setupIntents.create({
            customer: customer.id,
          });

          // Save to Firestore
          await db.collection('stripe_customers').doc(userRecord.uid).set({
            customer_id: customer.id,
            setup_secret: intent.client_secret,
          });

          console.log(`✅ Created Stripe customer for ${userRecord.uid} (${userRecord.email}) - Customer ID: ${customer.id}`);
          createdCount++;

          // Add a small delay to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 100));

        } catch (error) {
          console.error(`❌ Error processing user ${userRecord.uid} (${userRecord.email}):`, error.message);
          errorCount++;
        }
      }

      // Continue with next page if there are more users
      if (listUsersResult.pageToken) {
        await listAllUsers(listUsersResult.pageToken);
      }
    };

    await listAllUsers();

    console.log("\n📊 Migration Summary:");
    console.log(`   Total processed: ${processedCount}`);
    console.log(`   Created: ${createdCount}`);
    console.log(`   Skipped: ${skippedCount}`);
    console.log(`   Errors: ${errorCount}`);
    console.log("🎉 Migration completed!");

  } catch (error) {
    console.error("💥 Fatal error during migration:", error);
  } finally {
    // Exit the process
    process.exit(0);
  }
}

// Run the migration
createStripeCustomersForExistingUsers();