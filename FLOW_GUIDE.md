# Flow Builder - How to Use Guide

## Step-by-Step Instructions:

### 1. Create a Flow
1. Go to **Flow Builder** page
2. Click **"+ Trigger"** to add a trigger node
3. Click **"+ Send"** to add a message node
4. Click on each node to configure them

### 2. Configure Trigger Node
1. Click on the **Trigger** node (green box)
2. Set **Trigger Type**: 
   - `keyword` - triggers on specific words
   - `always` - triggers on any message
3. Set **Condition**:
   - For keywords: `hello,hi,help` (comma-separated)
   - For always: leave empty
4. Add **Description**: `Auto-reply to greetings`

### 3. Configure Send Node
1. Click on the **Send** node (blue box)
2. Enter your **Message**: `Hello! How can I help you?`

### 4. Save the Flow
1. Enter **Flow Name**: `Greeting Auto-Reply`
2. Select **Session**: Choose your WhatsApp session
3. Click **Save**

### 5. Test the Flow
1. Click **Debug** button
2. Enter test message: `hello`
3. Check if it shows "Would Trigger: YES"

### 6. Troubleshooting

**Flow not working? Check these:**

1. **Session Selection**: Make sure you selected the correct WhatsApp session
2. **Trigger Configuration**: 
   - For keyword triggers, use exact words: `hello,hi,help`
   - Check spelling and case sensitivity
3. **Flow Saved**: Make sure you clicked "Save" after creating the flow
4. **Session Ready**: Your WhatsApp session must be connected and ready

**Common Issues:**
- ❌ Flow not saved → Click "Save" button
- ❌ Wrong session → Select correct session in dropdown
- ❌ No trigger node → Add trigger node first
- ❌ Keywords not matching → Use exact words, check spelling

**Debug Steps:**
1. Use the **Debug** button to test your trigger
2. Check server logs for flow execution
3. Make sure your WhatsApp session is connected

### 7. Example Flow
```
Trigger (keyword: hello,hi) → Send (Hello! How can I help?)
```

This will automatically reply "Hello! How can I help?" when someone sends "hello" or "hi".

### 8. Advanced Features
- **Delay Node**: Add delays between actions
- **Condition Node**: Add logic conditions
- **Webhook Node**: Call external APIs
- **Multiple Nodes**: Chain multiple actions together

## Need Help?
1. Use the **Debug** button to test your flow
2. Check the server console for error messages
3. Make sure your WhatsApp session is connected and ready
