"use strict"

const invalidXsrfTokens = {}
let cachedXsrfToken = null

let backgroundCallCounter = 0

const cacheResult = callback => {
	const cache = {}
	return (...args) => (cache[args[0]] = cache[args[0]] || [callback(...args)])[0]
}

const cacheBackgroundCall = callback => cacheResult(backgroundCall(callback))

const wrapArgs = async args => {
	if(IS_CHROME) {
		const asyncValues = []
		
		args = JSON.stringify(args, (key, value) => {
			if(value instanceof Blob) {
				value = {
					__btrType: "Blob",
					body: `$btr_async_value_${asyncValues.push(value) - 1}$`
				}
			} else if(value instanceof ArrayBuffer) {
				value = {
					__btrType: "ArrayBuffer",
					body: Array.from(new Uint8Array(value))
				}
			} else if(value instanceof URLSearchParams) {
				value = {
					__btrType: "URLSearchParams",
					body: value.toString()
				}
			}
			
			return value
		})
		
		if(asyncValues.length > 0) {
			for(let i = asyncValues.length; i--;) {
				let value = asyncValues[i]
				
				if(value instanceof Blob) {
					value = Array.from(new Uint8Array(await value.arrayBuffer()))
				}
				
				asyncValues[i] = JSON.stringify(value)
			}
			
			args = args.replace(/"\$btr_async_value_(\d+)\$"/g, asyncValues)
		}
	}
	
	return args
}

const unwrapArgs = async args => {
	if(IS_CHROME) {
		args = JSON.parse(args, (key, value) => {
			const valueType = value?.__btrType
			
			if(valueType === "Blob") {
				value = new Blob([new Uint8Array(value.body)], { type: value.type })
			} else if(valueType === "ArrayBuffer") {
				value = new Uint8Array(value.body).buffer
			} else if(valueType === "URLSearchParams") {
				value = new URLSearchParams(value.body)
			}
			
			return value
		})
	}
	
	return args
}


const backgroundCall = callback => {
	const messageId = `RobloxApi.${backgroundCallCounter}`
	backgroundCallCounter++
	
	if(IS_BACKGROUND_PAGE) {
		MESSAGING.listen({
			[messageId]({ args, xsrf }, respond) {
				if(xsrf && (!cachedXsrfToken || invalidXsrfTokens[cachedXsrfToken]) && !invalidXsrfTokens[xsrf]) {
					cachedXsrfToken = xsrf
				}
				
				Promise.resolve()
					.then(async () => callback(...(await unwrapArgs(args))))
					.then(
						async result => respond({ success: true, result: await wrapArgs(result) }),
						err => respond({ success: false, result: err.message })
					)
			}
		})
		
		return callback
	}
	
	return (...args) => new Promise(async (resolve, reject) => {
		MESSAGING.send(messageId, { args: await wrapArgs(args), xsrf: getXsrfToken() }, async result => {
			if(result.success) {
				resolve(await unwrapArgs(result.result))
			} else {
				reject(result.result)
			}
		})
	})
}

const backgroundFetch = (url, init = {}) => {
	init = { ...init }
	
	const usingXsrf = init.xsrf
	
	if(usingXsrf) {
		delete init.xsrf
		
		if(!init.headers) {
			init.headers = {}
		}
		
		init.headers["X-CSRF-TOKEN"] = cachedXsrfToken
	}
	
	return fetch(url, init).then(res => {
		if(usingXsrf && !res.ok && res.status === 403 && res.headers.get("X-CSRF-TOKEN")) {
			if(init.headers["X-CSRF-TOKEN"]) {
				invalidXsrfTokens[init.headers["X-CSRF-TOKEN"]] = true
			}
			
			cachedXsrfToken = init.headers["X-CSRF-TOKEN"] = res.headers.get("X-CSRF-TOKEN")
			
			return fetch(url, init)
		}
		
		return res
	})
}

const RobloxApi = {
	api: {
		getUncachedProductInfo: backgroundCall(assetId =>
			backgroundFetch(`https://api.roblox.com/marketplace/productinfo?assetId=${assetId}`)
				.then(res => res.json())
		),
		getProductInfo: cacheResult(assetId => RobloxApi.api.getUncachedProductInfo(assetId))
	},
	badges: {
		deleteBadge: backgroundCall(badgeId =>
			backgroundFetch(`https://badges.roblox.com/v1/user/badges/${badgeId}`, {
				method: "DELETE",
				credentials: "include",
				xsrf: true
			}).then(res => res.json())
		)
	},
	catalog: {
		getItemDetails: backgroundCall(items =>
			backgroundFetch(`https://catalog.roblox.com/v1/catalog/items/details`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ items }),
				xsrf: true
			}).then(res => res.json())
		),
		getBundleDetails: cacheBackgroundCall(bundleId =>
			backgroundFetch(`https://catalog.roblox.com/v1/bundles/${bundleId}/details`)
				.then(res => res.json())
		)
	},
	friends: {
		getFriends: backgroundCall(userId =>
			backgroundFetch(`https://friends.roblox.com/v1/users/${userId}/friends`)
				.then(async res => (await res.json()).data)
		)
	},
	games: {
		getPlaceDetails: backgroundCall(placeIds =>
			backgroundFetch(`https://games.roblox.com/v1/games/multiget-place-details?placeIds=${placeIds.join("&placeIds=")}`)
				.then(res => res.json())
		)
	},
	inventory: {
		toggleInCollection: backgroundCall((assetType, assetId, addToCollection = true) =>
			backgroundFetch(`https://inventory.roblox.com/v1/collections/items/${assetType}/${assetId}`, {
				method: addToCollection ? "POST" : "DELETE",
				credentials: "include",
				xsrf: true
			}).then(
				async res => {
					const result = await res.json()
					const errorCode = result?.errors?.[0]?.code
					
					if(res.ok || errorCode === 7 || errorCode === 8) {
						// adding returns 7 if already in collection, delte returns 8 if not in collection
						return { inCollection: addToCollection }
					}
					
					return null // return null if error
				},
				() => null // return null if error
			)
		)
	},
	thumbnails: {
		getAvatarHeadshots: backgroundCall((userIds, size = "150x150") =>
			backgroundFetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userIds.join(",")}&size=${size}&format=Png`)
				.then(async res => (await res.json()).data)
		),
		getAvatarThumbnails: backgroundCall((userIds, size = "150x150") =>
			backgroundFetch(`https://thumbnails.roblox.com/v1/users/avatar?userIds=${userIds.join(",")}&size=${size}&format=Png`)
				.then(async res => (await res.json()).data)
		),
		getAssetThumbnails: backgroundCall((assetIds, size) =>
			backgroundFetch(`https://thumbnails.roblox.com/v1/assets?assetIds=${assetIds.join(",")}&size=${size}&format=Png`)
				.then(async res => (await res.json()).data)
		)
	},
	www: {
		getProfilePlayerGames: backgroundCall(userId =>
			backgroundFetch(`https://www.roblox.com/users/profile/playergames-json?userId=${userId}`)
				.then(res => res.json())
		),
		deleteAssetFromInventory: backgroundCall(assetId =>
			backgroundFetch(`https://www.roblox.com/asset/delete-from-inventory`, {
				method: "POST",
				credentials: "include",
				body: new URLSearchParams({ assetId }),
				xsrf: true
			}).then(res => res.json())
		)
	}
}