import {
  approveUser,
  blockUser,
  listPendingUsers,
  rejectUser,
  unblockUser,
} from '../services/account-admin-service.js'

async function listPending(request, response, next) {
  try {
    const data = await listPendingUsers(request.query)
    response.json({ data })
  } catch (error) {
    next(error)
  }
}

async function approve(request, response, next) {
  try {
    const data = await approveUser(request.auth.userId, request.params.userId)
    response.json({ data })
  } catch (error) {
    next(error)
  }
}

async function reject(request, response, next) {
  try {
    const data = await rejectUser(request.auth.userId, request.params.userId)
    response.json({ data })
  } catch (error) {
    next(error)
  }
}

async function block(request, response, next) {
  try {
    const data = await blockUser(request.auth.userId, request.params.userId)
    response.json({ data })
  } catch (error) {
    next(error)
  }
}

async function unblock(request, response, next) {
  try {
    const data = await unblockUser(request.auth.userId, request.params.userId)
    response.json({ data })
  } catch (error) {
    next(error)
  }
}

export { approve, block, listPending, reject, unblock }
