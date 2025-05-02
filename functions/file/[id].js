// --- START OF FILE [id].js ---

export async function onRequest(context) {
    const {
        request,
        env,
        params,
    } = context;

    const url = new URL(request.url);
    let fileUrl = 'https://telegra.ph/' + url.pathname + url.search;

    // --- Logic to determine fileUrl based on path length ---
    if (url.pathname.length > 39) { // Path length > 39 indicates file uploaded via Telegram Bot API
        try {
            const fileId = url.pathname.split(".")[0].split("/")[2];
            if (!fileId) {
                return new Response('Invalid file path format', { status: 400 });
            }
            console.log("Extracted file_id:", fileId);

            const filePath = await getFilePath(env, fileId);
            if (!filePath) {
                console.error("Failed to get file path for file_id:", fileId);
                return new Response('Could not retrieve file path from Telegram API', { status: 500 });
            }
            console.log("Retrieved file path:", filePath);
            fileUrl = `https://api.telegram.org/file/bot${env.TG_Bot_Token}/${filePath}`;
        } catch (e) {
             console.error("Error processing Telegram Bot API path:", e);
             return new Response('Error processing file path', { status: 500 });
        }
    }
    // --- End of fileUrl logic ---

    console.log("Fetching from URL:", fileUrl);

    // Fetch the actual image/file from the determined URL
    // IMPORTANT: Do NOT pass original request headers/body unless specifically needed
    // for the target fetch. Usually, for GET, you don't need them.
    const originResponse = await fetch(fileUrl, {
        method: "GET", // Usually GET for files, ensure this matches need
        // headers: request.headers, // Avoid passing browser headers to the origin unless necessary
        // body: request.body,    // Avoid passing browser body to the origin unless necessary
    });

    // If the fetch from the origin failed, return the error response
    if (!originResponse.ok) {
        console.error(`Origin fetch failed: ${originResponse.status} ${originResponse.statusText}`);
        // Return the actual error from the origin, might give clues
        return new Response(originResponse.body, {
             status: originResponse.status,
             statusText: originResponse.statusText,
             headers: originResponse.headers // Pass original error headers
        });
    }

    // Log response details from origin
    console.log("Origin response OK:", originResponse.status);

    // --- START: Prepare headers for the response TO THE BROWSER ---
    const responseHeaders = new Headers(originResponse.headers);

    // *** KEY CHANGE: Ensure browser displays inline (preview), not downloads ***
    // Remove Content-Disposition if it forces download
    responseHeaders.delete('Content-Disposition');
    // Optionally, explicitly set to inline (usually removing attachment is enough)
    // responseHeaders.set('Content-Disposition', 'inline');

    // Set cache headers if desired (optional, copy from origin or set new ones)
    // responseHeaders.set('Cache-Control', 'public, max-age=...');
    // --- END: Prepare headers for the response TO THE BROWSER ---


    // Helper function to create the final response with correct headers for preview
    const createPreviewResponse = () => {
        return new Response(originResponse.body, {
            status: originResponse.status,
            statusText: originResponse.statusText,
            headers: responseHeaders // Use the modified headers
        });
    };

    // --- Start conditional logic ---

    // Allow the admin page to directly view the image
    const isAdmin = request.headers.get('Referer')?.includes(`${url.origin}/admin`);
    if (isAdmin) {
        console.log("Admin access detected, serving image for preview.");
        return createPreviewResponse();
    }

    // Check if KV storage is available
    if (!env.img_url) {
        console.log("KV storage not available, returning image directly for preview.");
        return createPreviewResponse(); // Serve for preview
    }

    // The following code executes only if KV is available
    let record = await env.img_url.getWithMetadata(params.id);
    let metadata;

    if (!record || !record.metadata) {
        console.log("Metadata not found for", params.id, ", initializing...");
        metadata = { // Initialize directly
            ListType: "None",
            Label: "None",
            TimeStamp: Date.now(),
            liked: false,
            fileName: params.id, // Or derive from path if possible
            fileSize: parseInt(originResponse.headers.get('Content-Length') || '0'), // Get size from origin response
        };
        // No need to await put here yet, do it later if needed
    } else {
       metadata = { // Ensure all keys exist using defaults
           ListType: record.metadata.ListType || "None",
           Label: record.metadata.Label || "None",
           TimeStamp: record.metadata.TimeStamp || Date.now(),
           liked: record.metadata.liked !== undefined ? record.metadata.liked : false,
           fileName: record.metadata.fileName || params.id,
            // Update fileSize if missing or zero from origin header
           fileSize: record.metadata.fileSize || parseInt(originResponse.headers.get('Content-Length') || '0'),
       };
    }


    // --- Handle based on ListType and Label ---
    if (metadata.ListType === "White") {
        console.log("Image whitelisted, serving for preview.");
        return createPreviewResponse();
    } else if (metadata.ListType === "Block" || metadata.Label === "adult") {
        console.log(`Image blocked (ListType: ${metadata.ListType}, Label: ${metadata.Label}), redirecting.`);
        const referer = request.headers.get('Referer');
        const redirectUrl = referer ? "https://static-res.pages.dev/teleimage/img-block-compressed.png" : `${url.origin}/block-img.html`;
        // Save metadata before redirecting if it was just initialized/modified and caused block
        if (!record || !record.metadata) { // Only save if freshly initialized
            await env.img_url.put(params.id, "", { metadata });
        }
        return Response.redirect(redirectUrl, 302);
    }

    // Check if WhiteList_Mode is enabled (and image is not already White/Blocked)
    if (env.WhiteList_Mode === "true") {
        console.log("Whitelist mode enabled, redirecting.");
         // Save metadata before redirecting if it was just initialized
        if (!record || !record.metadata) {
             await env.img_url.put(params.id, "", { metadata });
        }
        return Response.redirect(`${url.origin}/whitelist-on.html`, 302);
    }

    // --- Content Moderation (only if not already handled) ---
    let moderationPerformed = false;
    if (env.ModerateContentApiKey && metadata.Label === "None" && metadata.ListType === "None") { // Only moderate if status is unknown
        try {
            console.log("Starting content moderation...");
            // Use the original telegra.ph URL for moderation, even for bot files,
            // as ModerateContent might work better with direct image URLs.
            // Construct the telegra.ph URL format regardless of how it was fetched.
            const moderationImageUrl = 'https://telegra.ph/' + url.pathname + url.search;
            const moderateUrl = `https://api.moderatecontent.com/moderate/?key=${env.ModerateContentApiKey}&url=${encodeURIComponent(moderationImageUrl)}`;
            const moderateResponse = await fetch(moderateUrl);
            moderationPerformed = true; // Flag that moderation was attempted

            if (!moderateResponse.ok) {
                console.error("Content moderation API request failed: " + moderateResponse.status);
            } else {
                const moderateData = await moderateResponse.json();
                console.log("Content moderation results:", moderateData);

                if (moderateData && moderateData.rating_label) {
                    metadata.Label = moderateData.rating_label; // Update metadata

                    if (metadata.Label === "adult") {
                        console.log("Content marked as adult by moderation, saving metadata and redirecting");
                        await env.img_url.put(params.id, "", { metadata }); // Save the adult label
                        const referer = request.headers.get('Referer');
                        const redirectUrl = referer ? "https://static-res.pages.dev/teleimage/img-block-compressed.png" : `${url.origin}/block-img.html`;
                        return Response.redirect(redirectUrl, 302); // Redirect immediately
                    }
                } else if (moderateData && moderateData.error) {
                     console.error("Content moderation API error:", moderateData.error);
                }
            }
        } catch (error) {
            console.error("Error during content moderation fetch: " + error.message);
            // Moderation failure should not block image serving unless critical
        }
    }

    // --- Save metadata if initialized or updated by moderation (and not blocked) ---
    // Metadata needs saving if it was newly initialized OR if moderation ran and updated the label (and didn't redirect)
     if (!record || !record.metadata || (moderationPerformed && metadata.Label !== "None")) {
        console.log("Saving metadata for", params.id);
        await env.img_url.put(params.id, "", { metadata });
     }


    // --- Final fallback: Return file content for preview ---
    console.log("Serving image for preview (default case).");
    return createPreviewResponse();
}


async function getFilePath(env, file_id) {
    if (!env.TG_Bot_Token) {
        console.error('TG_Bot_Token is not configured in environment variables.');
        return null;
    }
     if (!file_id) {
        console.error('file_id is missing in getFilePath call.');
        return null;
    }
    try {
        const url = `https://api.telegram.org/bot${env.TG_Bot_Token}/getFile?file_id=${file_id}`;
        console.log("Fetching file path from Telegram API:", url); // Log the URL being called
        const res = await fetch(url, { method: 'GET' });

        if (!res.ok) {
            console.error(`Telegram API /getFile error! Status: ${res.status}`);
            const errorBody = await res.text();
            console.error("Error body:", errorBody);
            return null;
        }

        const responseData = await res.json();
        console.log("Telegram API /getFile response:", responseData); // Log the response

        const { ok, result, description } = responseData;

        if (ok && result && result.file_path) {
            return result.file_path;
        } else {
            console.error('Error in Telegram API /getFile response data:', description || 'Unknown error', responseData);
            return null;
        }
    } catch (error) {
        console.error('Error fetching file path from Telegram API:', error.message);
        return null;
    }
}

// --- END OF FILE [id].js ---
