import {
   addCourseTeacherService,
   createCourseService,
   getCourseService,
   listCoursesService,
   listCourseTeachersService,
   publishCourseService,
   removeCourseTeacherService,
   unpublishCourseService,
   updateCourseService,
   updateCourseTeacherService,
} from '../services/course-service.js'

function overrides(req) {
   return req.app.locals.serviceDependencies.courses
}

async function listCoursesController(req, res, next) {
   try {
      const data = await listCoursesService(req.auth.userId, req.query, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function getCourseController(req, res, next) {
   try {
      const data = await getCourseService(req.auth.userId, req.params.courseId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function createCourseController(req, res, next) {
   try {
      const data = await createCourseService(req.auth.userId, req.body, overrides(req))
      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function updateCourseController(req, res, next) {
   try {
      const data = await updateCourseService(
         req.auth.userId,
         req.params.courseId,
         req.body,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function publishCourseController(req, res, next) {
   try {
      const data = await publishCourseService(req.auth.userId, req.params.courseId, overrides(req))
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function unpublishCourseController(req, res, next) {
   try {
      const data = await unpublishCourseService(
         req.auth.userId,
         req.params.courseId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function listCourseTeachersController(req, res, next) {
   try {
      const data = await listCourseTeachersService(
         req.auth.userId,
         req.params.courseId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function addCourseTeacherController(req, res, next) {
   try {
      const data = await addCourseTeacherService(
         req.auth.userId,
         req.params.courseId,
         req.body,
         overrides(req),
      )
      res.status(201).json({ data })
   } catch (error) {
      next(error)
   }
}

async function updateCourseTeacherController(req, res, next) {
   try {
      const data = await updateCourseTeacherService(
         req.auth.userId,
         req.params.courseId,
         req.params.userId,
         req.body,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

async function removeCourseTeacherController(req, res, next) {
   try {
      const data = await removeCourseTeacherService(
         req.auth.userId,
         req.params.courseId,
         req.params.userId,
         overrides(req),
      )
      res.json({ data })
   } catch (error) {
      next(error)
   }
}

export {
   addCourseTeacherController,
   createCourseController,
   getCourseController,
   listCoursesController,
   listCourseTeachersController,
   publishCourseController,
   removeCourseTeacherController,
   unpublishCourseController,
   updateCourseController,
   updateCourseTeacherController,
}
